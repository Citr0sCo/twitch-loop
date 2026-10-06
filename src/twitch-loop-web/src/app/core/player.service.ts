import { Injectable } from '@angular/core';

interface TwitchPlayerInstance {
  addEventListener(event: string, callback: () => void): void;
  setChannel(channel: string): void;
  setVolume(volume: number): void;
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
  private loaded: Promise<void> | null = null;
  private onPlaying: (() => void) | null = null;
  private onPlaybackBlocked: (() => void) | null = null;

  async mount(elementId: string, channel: string): Promise<void> {
    await this.loadSdk();
    this.player?.destroy();
    if (!window.Twitch) throw new Error('Twitch player SDK is unavailable');
    this.player = new window.Twitch.Player(elementId, { channel, width: '100%', height: '100%', parent: [window.location.hostname], autoplay: true, muted: false });
    this.player.addEventListener(window.Twitch.Player.READY, () => this.player?.setVolume(1));
    this.player.addEventListener(window.Twitch.Player.PLAYING, () => this.onPlaying?.());
    this.player.addEventListener(window.Twitch.Player.PLAYBACK_BLOCKED, () => this.onPlaybackBlocked?.());
  }

  setOnPlaying(callback: (() => void) | null): void { this.onPlaying = callback; }
  setOnPlaybackBlocked(callback: (() => void) | null): void { this.onPlaybackBlocked = callback; }
  setChannel(channel: string): void { this.player?.setChannel(channel); }
  play(): void { this.player?.play(); }
  destroy(): void { this.player?.destroy(); this.player = null; }

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
