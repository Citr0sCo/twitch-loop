import { Injectable } from '@angular/core';

interface TwitchPlayerInstance {
  addEventListener(event: string, callback: () => void): void;
  setChannel(channel: string): void;
  setVolume(volume: number): void;
  getQualities(): string[];
  getQuality(): string;
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
  private currentChannel: string | null = null;
  private loaded: Promise<void> | null = null;
  private onPlaying: (() => void) | null = null;
  private onPlaybackBlocked: (() => void) | null = null;

  async mount(elementId: string, channel: string): Promise<void> {
    await this.loadSdk();
    this.destroy();
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

  setOnPlaying(callback: (() => void) | null): void { this.onPlaying = callback; }
  setOnPlaybackBlocked(callback: (() => void) | null): void { this.onPlaybackBlocked = callback; }
  setChannel(channel: string): void {
    if (!this.player || this.currentChannel?.toLowerCase() === channel.toLowerCase()) return;
    this.player.setChannel(channel);
    this.currentChannel = channel;
  }
  play(): void { this.player?.play(); }
  destroy(): void { this.player?.destroy(); this.player = null; this.currentChannel = null; }

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
