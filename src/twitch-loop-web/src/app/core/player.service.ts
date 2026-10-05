import { Injectable } from '@angular/core';

interface TwitchPlayerInstance {
  addEventListener(event: string, callback: () => void): void;
  setChannel(channel: string): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  pause(): void;
  play(): void;
  destroy(): void;
}

declare global {
  interface Window { Twitch?: { Player: new (element: string, options: Record<string, unknown>) => TwitchPlayerInstance; }; }
}

@Injectable({ providedIn: 'root' })
export class PlayerService {
  private player: TwitchPlayerInstance | null = null;
  private loaded: Promise<void> | null = null;

  async mount(elementId: string, channel: string): Promise<void> {
    await this.loadSdk();
    this.player?.destroy();
    if (!window.Twitch) throw new Error('Twitch player SDK is unavailable');
    this.player = new window.Twitch.Player(elementId, { channel, width: '100%', height: '100%', parent: [window.location.hostname] });
  }

  setChannel(channel: string): void { this.player?.setChannel(channel); }
  setVolume(volume: number): void { this.player?.setVolume(volume); }
  setMuted(muted: boolean): void { this.player?.setMuted(muted); }
  async requestFullscreen(): Promise<void> {
    const target = document.querySelector<HTMLIFrameElement>('#twitch-player iframe') ?? document.getElementById('twitch-player');
    if (!target?.requestFullscreen) throw new Error('Fullscreen is unavailable for the Twitch player');
    await target.requestFullscreen();
  }
  pause(): void { this.player?.pause(); }
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
