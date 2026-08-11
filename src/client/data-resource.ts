import type {
  BootstrapData,
  Feed,
  Folder,
  ImportResult,
  RefreshResult,
  Rule,
  WebFeedConfig,
} from "../shared/types.js";
import {
  api,
  errorMessage,
  type FeedInput,
  type FeedUpdateInput,
  type FolderInput,
  type RuleInput,
} from "./api.js";

export type ArticleReloadMode = "query" | "mutation";

export interface ReaderDataBinding {
  getBootstrap: () => BootstrapData | null;
  applyBootstrap: (bootstrap: BootstrapData) => void;
  setBootstrapError: (message: string | null) => void;
  reloadArticles: (signal: AbortSignal, mode: ArticleReloadMode) => Promise<void>;
  reloadRules: (signal: AbortSignal) => Promise<void>;
}

export interface RefreshMutation {
  result: RefreshResult;
  settled: Promise<void>;
}

export interface ReaderDataMutations {
  createFeed(input: FeedInput): Promise<Feed>;
  importOpml(file: File): Promise<ImportResult>;
  updateFeed(id: number, input: FeedUpdateInput): Promise<Feed>;
  deleteFeed(id: number): Promise<void>;
  updateWebFeedSelection(id: number, config: WebFeedConfig): Promise<Feed>;
  createFolder(input: FolderInput): Promise<Folder>;
  updateFolder(id: number, input: Partial<FolderInput>): Promise<Folder>;
  deleteFolder(id: number): Promise<void>;
  createRule(input: RuleInput): Promise<Rule>;
  updateRule(id: number, input: Partial<RuleInput>): Promise<Rule>;
  deleteRule(id: number): Promise<void>;
}

type ReaderDataClient = Pick<
  typeof api,
  | "bootstrap"
  | "createFeed"
  | "importOpml"
  | "updateFeed"
  | "deleteFeed"
  | "updateWebFeedSelection"
  | "createFolder"
  | "updateFolder"
  | "deleteFolder"
  | "createRule"
  | "updateRule"
  | "deleteRule"
  | "refresh"
>;

class LatestRequest {
  private controller: AbortController | null = null;

  async run<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    try {
      return await request(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return undefined;
      throw error;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }
}

export class ReaderDataResource implements ReaderDataMutations {
  private binding: ReaderDataBinding | null = null;
  private readonly bootstrapRequest = new LatestRequest();
  private readonly articleRequest = new LatestRequest();
  private readonly ruleRequest = new LatestRequest();
  private readonly trackedFeedIds = new Set<number>();
  private observeRefreshingFeeds = false;
  private reloadArticlesAfterTracking = false;
  private pollTask: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private resolvePollDelay: (() => void) | null = null;
  private active = true;

  constructor(
    private readonly client: ReaderDataClient = api,
    private readonly pollIntervalMs = 1_000,
  ) {}

  connect(binding: ReaderDataBinding): void {
    this.binding = binding;
  }

  resume(): void {
    this.active = true;
    if (this.hasTrackedWork()) this.ensurePolling();
  }

  pause(): void {
    this.active = false;
    this.bootstrapRequest.cancel();
    this.articleRequest.cancel();
    this.ruleRequest.cancel();
    this.trackedFeedIds.clear();
    this.observeRefreshingFeeds = false;
    this.reloadArticlesAfterTracking = false;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.resolvePollDelay?.();
    this.resolvePollDelay = null;
  }

  cancelArticles(): void {
    this.articleRequest.cancel();
  }

  loadBootstrap = async (): Promise<void> => {
    await this.refreshBootstrap();
  };

  loadArticles = async (mode: ArticleReloadMode = "query"): Promise<void> => {
    const binding = this.binding;
    if (!this.active || !binding) return;
    try {
      await this.articleRequest.run((signal) => binding.reloadArticles(signal, mode));
    } catch {
      // The bound reader loader owns its visible error state.
    }
  };

  requestArticles = async <T>(
    request: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> => {
    if (!this.active) return undefined;
    return this.articleRequest.run(request);
  };

  loadRules = async (): Promise<void> => {
    const binding = this.binding;
    if (!this.active || !binding) return;
    try {
      await this.ruleRequest.run((signal) => binding.reloadRules(signal));
    } catch {
      // The bound rules loader owns its visible error state.
    }
  };

  reload = async ({
    articles = false,
    rules = false,
  }: {
    articles?: boolean;
    rules?: boolean;
  } = {}): Promise<void> => {
    await this.invalidateNow({ articles, rules });
  };

  createFeed = async (input: FeedInput): Promise<Feed> => {
    const feed = await this.client.createFeed(input);
    await this.invalidateRefreshing([feed.id]);
    return feed;
  };

  importOpml = async (file: File): Promise<ImportResult> => {
    const result = await this.client.importOpml(file);
    await this.invalidateRefreshing([], true);
    return result;
  };

  updateFeed = async (id: number, input: FeedUpdateInput): Promise<Feed> => {
    const feed = await this.client.updateFeed(id, input);
    await this.invalidateNow({ articles: true, rules: input.folderId !== undefined });
    return feed;
  };

  deleteFeed = async (id: number): Promise<void> => {
    await this.client.deleteFeed(id);
    await this.invalidateNow({ articles: true, rules: true });
  };

  updateWebFeedSelection = async (id: number, config: WebFeedConfig): Promise<Feed> => {
    const feed = await this.client.updateWebFeedSelection(id, config);
    await this.invalidateNow({ articles: true });
    return feed;
  };

  createFolder = async (input: FolderInput): Promise<Folder> => {
    const folder = await this.client.createFolder(input);
    await this.invalidateNow({ articles: true });
    return folder;
  };

  updateFolder = async (id: number, input: Partial<FolderInput>): Promise<Folder> => {
    const folder = await this.client.updateFolder(id, input);
    await this.invalidateNow({ articles: true });
    return folder;
  };

  deleteFolder = async (id: number): Promise<void> => {
    await this.client.deleteFolder(id);
    await this.invalidateNow({ articles: true, rules: true });
  };

  createRule = async (input: RuleInput): Promise<Rule> => {
    const rule = await this.client.createRule(input);
    await this.invalidateNow({ articles: true, rules: true });
    return rule;
  };

  updateRule = async (id: number, input: Partial<RuleInput>): Promise<Rule> => {
    const rule = await this.client.updateRule(id, input);
    await this.invalidateNow({ articles: true, rules: true });
    return rule;
  };

  deleteRule = async (id: number): Promise<void> => {
    await this.client.deleteRule(id);
    await this.invalidateNow({ articles: true, rules: true });
  };

  beginRefresh = async (
    feedIds: number[] | undefined,
    trackedFeedIds: number[],
  ): Promise<RefreshMutation> => {
    this.markRefreshing(trackedFeedIds);
    try {
      const result = await this.client.refresh(feedIds);
      const settled = this.invalidateRefreshing(
        [...trackedFeedIds, ...result.refreshingFeedIds],
        false,
        true,
      );
      return { result, settled };
    } catch (error) {
      void this.loadBootstrap();
      throw error;
    }
  };

  private async invalidateNow({
    articles,
    rules = false,
  }: {
    articles: boolean;
    rules?: boolean;
  }): Promise<void> {
    await Promise.all([
      this.refreshBootstrap(),
      articles ? this.loadArticles("mutation") : Promise.resolve(),
      rules ? this.loadRules() : Promise.resolve(),
    ]);
  }

  private async invalidateRefreshing(
    feedIds: number[],
    observeRefreshing = false,
    waitForSettlement = false,
  ): Promise<void> {
    for (const id of feedIds) this.trackedFeedIds.add(id);
    if (observeRefreshing) this.observeRefreshingFeeds = true;
    this.reloadArticlesAfterTracking = true;

    await this.refreshBootstrap();
    if (!this.hasTrackedWork()) {
      await this.flushTrackedArticleReload();
      return;
    }

    const settled = this.ensurePolling();
    if (waitForSettlement) await this.waitForTrackedSettlement(settled);
  }

  private async refreshBootstrap(): Promise<BootstrapData | undefined> {
    if (!this.active || !this.binding) return undefined;
    this.binding.setBootstrapError(null);
    try {
      const bootstrap = await this.bootstrapRequest.run((signal) => this.client.bootstrap(signal));
      if (!bootstrap || !this.binding) return undefined;
      this.binding.applyBootstrap(bootstrap);
      this.reconcileTrackedFeeds(bootstrap);
      return bootstrap;
    } catch (error) {
      this.binding?.setBootstrapError(errorMessage(error));
      return undefined;
    }
  }

  private reconcileTrackedFeeds(bootstrap: BootstrapData): void {
    if (this.observeRefreshingFeeds) {
      for (const feed of bootstrap.feeds) {
        if (feed.refreshing) this.trackedFeedIds.add(feed.id);
      }
      this.observeRefreshingFeeds = false;
    }

    for (const id of this.trackedFeedIds) {
      const feed = bootstrap.feeds.find((candidate) => candidate.id === id);
      if (!feed?.refreshing) this.trackedFeedIds.delete(id);
    }
  }

  private markRefreshing(feedIds: number[]): void {
    const binding = this.binding;
    const current = binding?.getBootstrap();
    if (!binding || !current) return;
    const ids = new Set(feedIds);
    binding.applyBootstrap({
      ...current,
      feeds: current.feeds.map((feed) => (ids.has(feed.id) ? { ...feed, refreshing: true } : feed)),
    });
  }

  private hasTrackedWork(): boolean {
    return this.trackedFeedIds.size > 0 || this.observeRefreshingFeeds;
  }

  private ensurePolling(): Promise<void> {
    if (this.pollTask) return this.pollTask;
    const task = this.pollRefreshing();
    this.pollTask = task;
    void task.finally(() => {
      if (this.pollTask === task) {
        this.pollTask = null;
        if (this.active && this.hasTrackedWork()) this.ensurePolling();
      }
    });
    return task;
  }

  private async waitForTrackedSettlement(initialTask: Promise<void>): Promise<void> {
    await initialTask;
    while (this.active && this.hasTrackedWork()) await this.ensurePolling();
  }

  private async pollRefreshing(): Promise<void> {
    while (this.active && this.hasTrackedWork()) {
      await this.waitForPoll();
      if (!this.active) return;
      await this.refreshBootstrap();
    }
    if (this.active) await this.flushTrackedArticleReload();
  }

  private async flushTrackedArticleReload(): Promise<void> {
    if (!this.reloadArticlesAfterTracking) return;
    this.reloadArticlesAfterTracking = false;
    await this.loadArticles("mutation");
  }

  private waitForPoll(): Promise<void> {
    return new Promise((resolve) => {
      this.resolvePollDelay = resolve;
      this.pollTimer = setTimeout(() => {
        this.pollTimer = null;
        this.resolvePollDelay = null;
        resolve();
      }, this.pollIntervalMs);
    });
  }
}
