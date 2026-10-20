import type Hls from 'hls.js';
import type { ErrorData, FragLoadedData, Level, LevelLoadedData } from 'hls.js';

interface AdRange {
  start: number;
  end: number;
}

export function applyHlsVideoStyles(video: HTMLVideoElement): void {
  video.style.background = '#000';
  video.style.display = 'block';
  video.style.height = '100%';
  video.style.inset = '0';
  video.style.maxHeight = '100%';
  video.style.maxWidth = '100%';
  video.style.objectFit = 'contain';
  video.style.position = 'absolute';
  video.style.width = '100%';
}

export class HlsPlayer {
  private video: HTMLVideoElement | null = null;
  private hls: Hls | null = null;
  private elementId: string | null = null;
  private currentChannel: string | null = null;
  private onPlaying: (() => void) | null = null;
  private onPlaybackBlocked: (() => void) | null = null;
  private lastCurrentTime = 0;
  private recoveryAttempts = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private adClearTimer: ReturnType<typeof setTimeout> | null = null;
  private adFreeMode = false;
  private adUntil = 0;
  private mutedForAds = false;
  private activeAdRanges: AdRange[] = [];
  private highestLevel = -1;
  private highestAdFreeLevel = -1;

  setOnPlaying(callback: (() => void) | null): void { this.onPlaying = callback; }
  setOnPlaybackBlocked(callback: (() => void) | null): void { this.onPlaybackBlocked = callback; }

  async mount(elementId: string, channel: string): Promise<void> {
    this.destroy();
    const container = document.getElementById(elementId);
    if (!container) throw new Error('Player container is unavailable');
    container.replaceChildren();

    const video = document.createElement('video');
    video.className = 'hls-player';
    applyHlsVideoStyles(video);
    video.autoplay = true;
    video.controls = true;
    video.playsInline = true;
    video.muted = false;
    video.volume = 1;
    video.addEventListener('playing', this.handlePlaying);
    container.appendChild(video);

    this.video = video;
    this.elementId = elementId;
    this.currentChannel = channel;
    this.lastCurrentTime = 0;

    try {
      const { default: HlsPlayerClass } = await import('hls.js');
      if (!this.video || this.elementId !== elementId) return;

      if (HlsPlayerClass.isSupported()) {
        const hls = new HlsPlayerClass({
          enableWorker: true,
          lowLatencyMode: true,
          liveSyncDurationCount: 2,
          liveMaxLatencyDurationCount: 4,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          backBufferLength: 30,
          manifestLoadingTimeOut: 20000,
          levelLoadingTimeOut: 20000,
          fragLoadingTimeOut: 20000
        });
        this.hls = hls;
        hls.on(HlsPlayerClass.Events.MEDIA_ATTACHED, () => hls.loadSource(this.masterUrl(channel)));
        hls.on(HlsPlayerClass.Events.MANIFEST_PARSED, () => this.handleManifestParsed());
        hls.on(HlsPlayerClass.Events.LEVEL_LOADED, (_event, data) => this.handleLevelLoaded(data));
        hls.on(HlsPlayerClass.Events.FRAG_LOADED, (_event, data) => this.handleFragLoaded(data));
        hls.on(HlsPlayerClass.Events.ERROR, (_event, data) => this.handleError(data));
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = this.masterUrl(channel);
        this.attemptPlay();
      } else {
        throw new Error('HLS playback is not supported in this browser');
      }
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  setChannel(channel: string): void {
    if (!this.video || this.currentChannel?.toLowerCase() === channel.toLowerCase()) return;
    this.currentChannel = channel;
    this.lastCurrentTime = 0;
    this.recoveryAttempts = 0;
    this.activeAdRanges = [];
    this.adFreeMode = false;
    this.adUntil = 0;
    this.highestLevel = -1;
    this.highestAdFreeLevel = -1;
    this.clearAdClearTimer();
    this.setMutedForAds(false);

    if (this.hls) {
      this.hls.loadSource(this.masterUrl(channel));
      this.hls.startLoad();
    } else {
      this.video.src = this.masterUrl(channel);
      this.attemptPlay();
    }
  }

  play(): void { this.attemptPlay(); }

  getHealth(): { paused: boolean; hasPlaybackActivity: boolean } | null {
    const video = this.video;
    if (!video) return null;
    const current = video.currentTime;
    const progressed = Math.abs(current - this.lastCurrentTime) > 0.05;
    this.lastCurrentTime = current;
    return {
      paused: video.paused,
      hasPlaybackActivity: !video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && progressed
    };
  }

  destroy(): void {
    this.clearRecoveryTimer();
    this.clearAdClearTimer();

    const hls = this.hls;
    this.hls = null;
    try { hls?.destroy(); } catch {}

    const video = this.video;
    this.video = null;
    if (video) {
      video.removeEventListener('playing', this.handlePlaying);
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.remove();
      } catch {}
    }

    this.elementId = null;
    this.currentChannel = null;
    this.lastCurrentTime = 0;
    this.activeAdRanges = [];
    this.adFreeMode = false;
    this.adUntil = 0;
    this.mutedForAds = false;
    this.highestLevel = -1;
    this.highestAdFreeLevel = -1;
  }

  private handlePlaying = (): void => {
    this.recoveryAttempts = 0;
    this.onPlaying?.();
  };

  private handleManifestParsed(): void {
    if (!this.hls) return;
    this.highestLevel = this.findHighestLevel(false);
    this.highestAdFreeLevel = this.findHighestLevel(true);
    if (this.highestLevel >= 0) this.switchLevel(this.highestLevel);
    this.attemptPlay();
  }

  private handleLevelLoaded(data: LevelLoadedData): void {
    const ranges = this.readAdRanges(data.details);
    this.activeAdRanges = ranges;

    if (ranges.length > 0) {
      this.clearAdClearTimer();
      this.adUntil = Math.max(this.adUntil, ...ranges.map(range => range.end));
      const currentLevel = this.hls?.currentLevel ?? -1;
      const currentIsAdFree = currentLevel >= 0 && this.isAdFree(this.hls?.levels[currentLevel]);
      if (this.highestAdFreeLevel >= 0 && !currentIsAdFree) {
        this.adFreeMode = true;
        this.switchLevel(this.highestAdFreeLevel);
        this.scheduleAdReturn();
      } else if (this.highestAdFreeLevel < 0) {
        this.setMutedForAds(true);
      }
      if (this.adFreeMode) this.scheduleAdReturn();
      return;
    }

    if (this.adFreeMode) {
      this.scheduleAdReturn();
      return;
    }

    this.setMutedForAds(false);
  }

  private handleFragLoaded(data: FragLoadedData): void {
    if (!this.video || !this.hls || this.adFreeMode || this.activeAdRanges.length === 0) return;
    const dateTime = data.frag.programDateTime;
    if (!dateTime) return;
    if (!this.activeAdRanges.some(range => dateTime >= range.start && dateTime < range.end)) return;

    this.setMutedForAds(true);
    const target = data.frag.end - (this.hls.targetLatency ?? 0);
    if (!Number.isFinite(target) || this.video.seekable.length === 0) return;
    const seekableEnd = this.video.seekable.end(this.video.seekable.length - 1);
    if (target > this.video.currentTime && target <= seekableEnd) this.video.currentTime = target;
  }

  private handleError(data: ErrorData): void {
    if (!data.fatal) return;

    if (data.type === 'mediaError') {
      try { this.hls?.recoverMediaError(); } catch {}
      return;
    }

    if (data.type !== 'networkError' || this.recoveryAttempts >= 2) return;
    this.recoveryAttempts++;
    const elementId = this.elementId;
    const channel = this.currentChannel;
    if (!elementId || !channel) return;

    this.clearRecoveryTimer();
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (this.elementId !== elementId || this.currentChannel !== channel) return;
      void this.mount(elementId, channel).catch(() => this.onPlaybackBlocked?.());
    }, 2000);
  }

  private readAdRanges(details: LevelLoadedData['details']): AdRange[] {
    const ranges = details?.dateRanges;
    if (!ranges) return [];

    const result: AdRange[] = [];
    for (const key of Object.keys(ranges)) {
      const range = ranges[key];
      if (!range) continue;
      const marker = `${range.id || key} ${range.attr?.['CLASS'] ?? ''}`;
      if (!/stitched-ad|quartile/i.test(marker)) continue;

      const start = range.startDate instanceof Date ? range.startDate.getTime() : Number.NaN;
      const duration = range.duration ?? Number(range.attr?.['DURATION'] ?? 0);
      if (!Number.isFinite(start)) continue;

      const end = range.endDate instanceof Date
        ? range.endDate.getTime()
        : start + (Number.isFinite(duration) ? duration * 1000 : 0);
      if (end > start) result.push({ start, end });
    }
    return result;
  }

  private isAdFree(level: Level | undefined): boolean {
    if (!level) return false;
    const value = level.attrs?.['X-TWITCH-LOOP-AD-FREE'] ?? level.attrs?.['x-twitch-loop-ad-free'];
    return String(value).toUpperCase() === 'YES';
  }

  private findHighestLevel(adFreeOnly: boolean): number {
    const levels = this.hls?.levels ?? [];
    let best = -1;
    for (let index = 0; index < levels.length; index++) {
      const level = levels[index];
      if (!level.height) continue;
      if (adFreeOnly && !this.isAdFree(level)) continue;
      if (best < 0 || level.height > levels[best].height
        || (level.height === levels[best].height && level.bitrate > levels[best].bitrate)) {
        best = index;
      }
    }
    return best;
  }

  private switchLevel(index: number): void {
    if (!this.hls || index < 0 || this.hls.currentLevel === index) return;
    try { this.hls.currentLevel = index; } catch {}
  }

  private setMutedForAds(muted: boolean): void {
    const video = this.video;
    if (!video) return;
    if (muted && !video.muted) {
      video.muted = true;
      this.mutedForAds = true;
    } else if (!muted && this.mutedForAds) {
      video.muted = false;
      this.mutedForAds = false;
    }
  }

  private attemptPlay(): void {
    const video = this.video;
    if (!video) return;
    const result = video.play();
    if (result && typeof result.catch === 'function') result.catch(() => this.onPlaybackBlocked?.());
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private scheduleAdReturn(): void {
    if (this.adClearTimer !== null) return;
    const wait = Math.max(0, this.adUntil - Date.now()) + 10000;
    this.adClearTimer = setTimeout(() => {
      this.adClearTimer = null;
      this.adFreeMode = false;
      this.adUntil = 0;
      this.switchLevel(this.highestLevel >= 0 ? this.highestLevel : this.findHighestLevel(false));
      this.setMutedForAds(false);
    }, wait);
  }

  private clearAdClearTimer(): void {
    if (this.adClearTimer !== null) clearTimeout(this.adClearTimer);
    this.adClearTimer = null;
  }

  private masterUrl(channel: string): string {
    return `/api/playback/${encodeURIComponent(channel)}/master.m3u8`;
  }
}
