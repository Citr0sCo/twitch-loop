import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class WakeLockService {
  private sentinel: WakeLockSentinel | null = null;
  supported(): boolean { return 'wakeLock' in navigator; }
  active(): boolean { return this.sentinel !== null; }
  async request(): Promise<boolean> {
    if (!('wakeLock' in navigator)) return false;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => { this.sentinel = null; });
      return true;
    } catch { return false; }
  }
  async release(): Promise<void> { await this.sentinel?.release(); this.sentinel = null; }
}
