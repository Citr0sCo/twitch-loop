import { Injectable } from '@angular/core';
import { HlsPlayer } from './hls-player';
import { PlayerMode } from './player-mode';

interface PlaybackStats {
  fps?: number;
  playbackRate?: number;
}

export interface PlayerHealth {
  paused: boolean;
  hasPlaybackActivity: boolean;
}

interface TwitchPlayerInstance {
  addEventListener(event: string, callback: () => void): void;
  setChannel(channel: string): void;
  setVolume(volume: number): void;
  getQualities(): string[];
  getQuality(): string;
  getPlaybackStats(): PlaybackStats;
  isPaused(): boolean;
  setQuality(quality: string): void;
  play(): void;
  destroy(): void;
}

interface TwitchPlayerConstructor {
  new (element: string, options: Record<string, unknown>): TwitchPlayerInstance;
  READY: string;
  PLAYING: string;
  PLAYBACK_BLOCKED: string;
}

declare global {
  interface Window { Twitch?: { Player: TwitchPlayerConstructor; }; }
}

@Injectable({ providedIn: 'root' })
export class PlayerService {
  private player: TwitchPlayerInstance | null = null;
  private hls: HlsPlayer | null = null;
  private mode: PlayerMode = 'official';
  private currentChannel: string | null = null;
  private loaded: Promise<void> | null = null;
  private onPlaying: (() => void) | null = null;
  private onPlaybackBlocked: (() => void) | null = null;

  setMode(mode: PlayerMode): void {
    if (this.mode === mode) return;
    this.destroy();
    this.mode = mode;
  }

  getMode(): PlayerMode { return this.mode; }

  async mount(elementId: string, channel: string): Promise<void> {
    this.destroy();
    const mode = this.mode;
    if (mode === 'hls') {
      const hls = new HlsPlayer();
      hls.setOnPlaying(() => this.onPlaying?.());
      hls.setOnPlaybackBlocked(() => this.onPlaybackBlocked?.());
      this.hls = hls;
      await hls.mount(elementId, channel);
      if (this.mode !== mode) {
        hls.destroy();
        return this.mount(elementId, channel);
      }
      this.currentChannel = channel;
      return;
    }

    await this.loadSdk();
    if (this.mode !== mode) return this.mount(elementId, channel);
    if (!window.Twitch) throw new Error('Twitch player SDK is unavailable');
    this.player = new window.Twitch.Player(elementId, { channel, width: '100%', height: '100%', parent: [window.location.hostname], autoplay: true, muted: false });
    this.currentChannel = channel;
    this.player.addEventListener(window.Twitch.Player.READY, () => {
      this.player?.setVolume(1);
      this.selectHighestQuality();
    });
    this.player.addEventListener(window.Twitch.Player.PLAYING, () => {
      this.selectHighestQuality();
      this.onPlaying?.();
    });
    this.player.addEventListener(window.Twitch.Player.PLAYBACK_BLOCKED, () => this.onPlaybackBlocked?.());
  }

  setOnPlaying(callback: (() => void) | null): void { this.onPlaying = callback; this.hls?.setOnPlaying(callback); }
  setOnPlaybackBlocked(callback: (() => void) | null): void { this.onPlaybackBlocked = callback; this.hls?.setOnPlaybackBlocked(callback); }
  getHealth(): PlayerHealth | null {
    if (this.mode === 'hls') return this.hls?.getHealth() ?? null;
    if (!this.player) return null;
    try {
      const stats = this.player.getPlaybackStats();
      const hasFps = Number.isFinite(stats.fps);
      const hasPlaybackRate = Number.isFinite(stats.playbackRate);
      if (!hasFps && !hasPlaybackRate) return null;
      return {
        paused: this.player.isPaused(),
        hasPlaybackActivity: hasFps
          ? (stats.fps ?? 0) > 0
          : hasPlaybackRate && (stats.playbackRate ?? 0) > 0
      };
    } catch {
      return null;
    }
  }
  setChannel(channel: string): void {
    if (this.mode === 'hls') {
      if (this.currentChannel?.toLowerCase() === channel.toLowerCase()) return;
      this.hls?.setChannel(channel);
      this.currentChannel = channel;
      return;
    }

    if (!this.player || this.currentChannel?.toLowerCase() === channel.toLowerCase()) return;
    this.player.setChannel(channel);
    this.currentChannel = channel;
  }
  play(): void {
    if (this.mode === 'hls') {
      this.hls?.play();
      return;
    }
    this.player?.play();
  }
  destroy(): void {
    const hls = this.hls;
    this.hls = null;
    const player = this.player;
    this.player = null;
    this.currentChannel = null;
    try { hls?.destroy(); } catch {}
    try { player?.destroy(); } catch {}
  }

  private selectHighestQuality(): void {
    if (!this.player) return;
    try {
      const qualities = this.player.getQualities();
      const quality = qualities.includes('chunked')
        ? 'chunked'
        : qualities.filter(value => /\d+p\d*/i.test(value)).sort((left, right) => {
          const leftResolution = Number(/(\d+)p/i.exec(left)?.[1] ?? 0);
          const rightResolution = Number(/(\d+)p/i.exec(right)?.[1] ?? 0);
          if (leftResolution !== rightResolution) return rightResolution - leftResolution;
          const leftFrameRate = Number(/p\d+/i.exec(left)?.[0].slice(1) ?? 0);
          const rightFrameRate = Number(/p\d+/i.exec(right)?.[0].slice(1) ?? 0);
          return rightFrameRate - leftFrameRate;
        })[0];
      if (quality && this.player.getQuality() !== quality) this.player.setQuality(quality);
    } catch {
      // Twitch can report qualities before they are available during stream changes.
    }
  }

  private loadSdk(): Promise<void> {
    if (this.loaded) return this.loaded;
    this.loaded = new Promise<void>((resolve, reject) => {
      if (window.Twitch) { resolve(); return; }
      const script = document.createElement('script');
      script.src = 'https://player.twitch.tv/js/embed/v1.js';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Could not load the official Twitch player SDK'));
      document.head.appendChild(script);
    });
    return this.loaded;
  }
}
