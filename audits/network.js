const Audit = require('lighthouse').Audit;
const i18n = require('lighthouse/lighthouse-core/lib/i18n/i18n.js');
const NetworkRecords = require('lighthouse/lighthouse-core/computed/network-records');
const MainThreadTasks = require('lighthouse/lighthouse-core/computed/main-thread-tasks');
const { getJavaScriptURLs, getAttributableURLForTask } = require('lighthouse/lighthouse-core/lib/tracehouse/task-summary');

const UIStrings = {
  title: 'Minimize third-party usage',
  failureTitle: 'Reduce the impact of third-party code',
  description: 'Third-party code can significantly impact load performance. ' +
    'Limit the number of redundant third-party providers and try to load third-party code after ' +
    'your page has primarily finished loading. [Learn more](https://developers.google.com/web/fundamentals/performance/optimizing-content-efficiency/loading-third-party-javascript/).',

  columnThirdParty: 'Third-Party',
  displayValue: 'Third-party code blocked the main thread for ' +
    `{timeInMs, number, milliseconds}\xa0ms`,
};

const str_ = i18n.createMessageInstanceIdFn(__filename, UIStrings);
const PASS_THRESHOLD_IN_MS = 250;
const MIN_TRANSFER_SIZE_FOR_SUBITEMS = 4096;

const MAX_SUBITEMS = 100;

class ThirdPartySummary extends Audit {
  static get meta() {
    return {
      id: 'third-party-summary',
      title: str_(UIStrings.title),
      failureTitle: str_(UIStrings.failureTitle),
      description: str_(UIStrings.description),
      requiredArtifacts: ['traces', 'devtoolsLogs', 'URL'],
    };
  }
  static getSummaries(networkRecords, mainThreadTasks, cpuMultiplier) {
    const byEntity = new Map();
    const defaultSummary = { mainThreadTime: 0, blockingTime: 0, transferSize: 0 };

    for (const request of networkRecords) {
      const urlSummary = byURL.get(request.url) || { ...defaultSummary };
      urlSummary.transferSize += request.transferSize;
      byURL.set(request.url, urlSummary);
    }

    const jsURLs = getJavaScriptURLs(networkRecords);

    for (const task of mainThreadTasks) {
      const attributableURL = getAttributableURLForTask(task, jsURLs);

      const urlSummary = byURL.get(attributableURL) || { ...defaultSummary };
      const taskDuration = task.selfTime * cpuMultiplier;
      urlSummary.mainThreadTime += taskDuration;
      urlSummary.blockingTime += Math.max(taskDuration - 50, 0);
      byURL.set(attributableURL, urlSummary);
    }
    const urls = new Map();
    for (const [url, urlSummary] of byURL.entries()) {
      const entity = new URL(url).host;
      const entitySummary = byEntity.get(entity) || { ...defaultSummary };
      entitySummary.transferSize += urlSummary.transferSize;
      entitySummary.mainThreadTime += urlSummary.mainThreadTime;
      entitySummary.blockingTime += urlSummary.blockingTime;
      byEntity.set(entity, entitySummary);

      const entityURLs = urls.get(entity) || [];
      entityURLs.push(url);
      urls.set(entity, entityURLs);
    }
    console.log("🚀 ~ file: network.js ~ line 72 ~ ThirdPartySummary ~ getSummaries ~  byURL, byEntity, urls ",  byURL, byEntity, urls )
    return { byURL, byEntity, urls };
  }
  static makeSubItems(entity, summaries, stats) {
    const entityURLs = summaries.urls.get(entity) || [];
    let items = entityURLs
      .map(url => ({ url, ...summaries.byURL.get(url) }))
      .filter((stat) => stat.transferSize > 0)
      .sort((a, b) => (b.blockingTime - a.blockingTime) || (b.transferSize - a.transferSize));

    const subitemSummary = { transferSize: 0, blockingTime: 0 };
    const minTransferSize = Math.max(MIN_TRANSFER_SIZE_FOR_SUBITEMS, stats.transferSize / 20);
    const maxSubItems = Math.min(MAX_SUBITEMS, items.length);
    let numSubItems = 0;
    while (numSubItems < maxSubItems) {
      const nextSubItem = items[numSubItems];
      if (nextSubItem.blockingTime === 0 && nextSubItem.transferSize < minTransferSize) {
        break;
      }

      numSubItems++;
      subitemSummary.transferSize += nextSubItem.transferSize;
      subitemSummary.blockingTime += nextSubItem.blockingTime;
    }
    if (!subitemSummary.blockingTime && !subitemSummary.transferSize) {
      return [];
    }
    items = items.slice(0, numSubItems);
    const remainder = {
      url: str_(i18n.UIStrings.otherResourcesLabel),
      transferSize: stats.transferSize - subitemSummary.transferSize,
      blockingTime: stats.blockingTime - subitemSummary.blockingTime,
    };
    if (remainder.transferSize > minTransferSize) {
      items.push(remainder);
    }
    return items;
  }

  static async audit(artifacts, context) {
    const settings = context.settings || {};
    const trace = artifacts.traces[Audit.DEFAULT_PASS];
    const devtoolsLog = artifacts.devtoolsLogs[Audit.DEFAULT_PASS];
    const networkRecords = await NetworkRecords.request(devtoolsLog, context);
    const mainEntity = new URL(artifacts.URL.finalUrl).host;
    const tasks = await MainThreadTasks.request(trace, context);
    const multiplier = settings.throttlingMethod === 'simulate' ?
      settings.throttling.cpuSlowdownMultiplier : 1;

    const summaries = ThirdPartySummary.getSummaries(networkRecords, tasks, multiplier);
    const overallSummary = { wastedBytes: 0, wastedMs: 0 };

    const results = Array.from(summaries.byEntity.entries())
      .filter(([entity]) => !(mainEntity && mainEntity === entity))
      .map(([entity, stats]) => {
        overallSummary.wastedBytes += stats.transferSize;
        overallSummary.wastedMs += stats.blockingTime;

        return {
          ...stats,
          entity: {
            type: ('link'),
            text: entity,
            url: entity || '',
          },
          subItems: {
            type: ('subitems'),
            items: ThirdPartySummary.makeSubItems(entity, summaries, stats),
          },
        };
      })
      .sort((a, b) => (b.blockingTime - a.blockingTime) || (b.transferSize - a.transferSize));

    const headings = [
      { key: 'entity', itemType: 'link', text: str_(UIStrings.columnThirdParty), subItemsHeading: { key: 'url', itemType: 'url' } },
      { key: 'transferSize', granularity: 1, itemType: 'bytes', text: str_(i18n.UIStrings.columnTransferSize), subItemsHeading: { key: 'transferSize' } },
      { key: 'blockingTime', granularity: 1, itemType: 'ms', text: str_(i18n.UIStrings.columnBlockingTime), subItemsHeading: { key: 'blockingTime' } },
    ];

    if (!results.length) {
      return {
        score: 1,
        notApplicable: true,
      };
    }

    return {
      score: Number(overallSummary.wastedMs <= PASS_THRESHOLD_IN_MS),
      displayValue: str_(UIStrings.displayValue, {
        timeInMs: overallSummary.wastedMs,
      }),
      details: Audit.makeTableDetails(headings, results, overallSummary),
    };
  }
}




module.exports = ThirdPartySummary;
module.exports.UIStrings = UIStrings;