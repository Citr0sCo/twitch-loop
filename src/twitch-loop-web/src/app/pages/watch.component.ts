import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, NgZone, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { EMPTY, Subscription, catchError, interval, startWith, switchMap } from 'rxjs';
import { ApiService, PriorityStatus, SessionState } from '../core/api.service';
import { PlayerService } from '../core/player.service';
import { WakeLockService } from '../core/wake-lock.service';

@Component({ selector: 'tl-watch', standalone: true, imports: [CommonModule, FormsModule], templateUrl: './watch.component.html', styleUrl: './watch.component.scss' })
export class WatchComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly player = inject(PlayerService);
  private readonly wakeLock = inject(WakeLockService);
  private readonly zone = inject(NgZone);
  private pollSubscription: Subscription | null = null;
  private statusSubscription: Subscription | null = null;
  private pendingChannel: string | null = null;
  private lastRevision = 0;
  private playerMounted = false;
  session: SessionState | null = null;
  priorityStatus: PriorityStatus = { channels: [], checkedAt: null };
  playerPlaying = false;
  manualChannel = '';
  volume = 80;
  muted = true;
  paused = false;
  starting = false;
  theatre = false;
  message = '';
  error = '';

  get playbackState(): string {
    if (this.playerPlaying) return 'playing';
    return this.session?.channel ? 'connecting' : this.session?.state || 'stopped';
  }

  ngOnInit(): void {
    this.player.setOnPlaying(() => this.zone.run(() => this.onPlayerPlaying()));
    this.pollPriorityStatus();
    const existing = sessionStorage.getItem('twitch-loop-session');
    if (existing) this.poll(existing);
    else this.start();
  }

  start(channel?: string): void {
    if (this.starting) return;
    this.starting = true;
    this.error = '';
    this.api.startSession().subscribe({
      next: session => {
        this.starting = false;
        sessionStorage.setItem('twitch-loop-session', session.sessionId);
        this.apply(session);
        this.poll(session.sessionId);
        void this.wakeLock.request();
        const requestedChannel = channel ?? this.pendingChannel;
        this.pendingChannel = null;
        if (requestedChannel) this.requestChannel(session.sessionId, requestedChannel);
      },
      error: () => {
        this.starting = false;
        this.error = 'Could not start a playback session. Check the server connection.';
      }
    });
  }

  stop(): void {
    if (!this.session) return;
    this.api.sessionAction(this.session.sessionId, 'stop').subscribe({ next: state => { this.apply(state); this.player.destroy(); this.playerMounted = false; this.playerPlaying = false; void this.wakeLock.release(); } });
  }

  toggleAuto(): void {
    if (!this.session) return;
    const action = this.session.automationMode === 'paused' ? 'resumeAuto' : 'pauseAuto';
    this.api.sessionAction(this.session.sessionId, action).subscribe({ next: state => this.apply(state) });
  }

  selectChannel(): void {
    const channel = this.manualChannel.trim().replace(/^@/, '').toLowerCase();
    if (!channel) return;
    if (!/^[a-z0-9_]{1,25}$/.test(channel)) {
      this.error = 'Enter a valid Twitch channel login.';
      return;
    }
    this.error = '';
    if (this.starting) {
      this.pendingChannel = channel;
      this.manualChannel = '';
    } else if (this.session && this.session.state !== 'stopped') this.requestChannel(this.session.sessionId, channel);
    else this.start(channel);
  }

  reset(): void { sessionStorage.removeItem('twitch-loop-session'); this.session = null; this.lastRevision = 0; this.playerMounted = false; this.playerPlaying = false; this.player.destroy(); void this.wakeLock.release(); }
  setVolume(): void { this.player.setVolume(this.volume / 100); }
  toggleMute(): void { this.muted = !this.muted; this.player.setMuted(this.muted); }
  toggleTheatre(): void { this.theatre = !this.theatre; }
  nativeFullscreen(): void { void this.player.requestFullscreen().catch(() => this.error = 'Fullscreen is unavailable for the Twitch player.'); }

  ngOnDestroy(): void { this.pollSubscription?.unsubscribe(); this.statusSubscription?.unsubscribe(); this.player.setOnPlaying(null); this.player.destroy(); void this.wakeLock.release(); }

  private requestChannel(sessionId: string, channel: string): void {
    this.api.sessionAction(sessionId, 'selectChannel', channel).subscribe({ next: state => { this.apply(state); this.manualChannel = ''; this.error = ''; }, error: () => this.error = 'Could not switch to that Twitch channel.' });
  }

  private poll(id: string): void {
    this.pollSubscription?.unsubscribe();
    this.pollSubscription = interval(15000).pipe(startWith(0), switchMap(() => this.api.currentSession(id))).subscribe({ next: state => this.apply(state), error: () => this.message = 'Waiting for the local API…' });
  }


  private pollPriorityStatus(): void {
    this.statusSubscription = interval(15000).pipe(
      startWith(0),
      switchMap(() => this.api.priorityStatus().pipe(catchError(() => EMPTY)))
    ).subscribe(status => this.priorityStatus = status);
  }

  private onPlayerPlaying(): void {
    this.playerPlaying = true;
    if (this.session) this.session = { ...this.session, state: 'playing' };
  }

  private apply(state: SessionState): void {
    if (state.revision < this.lastRevision) return;
    const changed = state.channel !== this.session?.channel;
    if (changed) this.playerPlaying = false;
    this.lastRevision = state.revision; this.session = state;
    if (state.channel && changed) void this.mountOrSwitch(state.channel);
  }

  private async mountOrSwitch(channel: string): Promise<void> {
    try {
      if (this.playerMounted) this.player.setChannel(channel);
      else {
        await this.player.mount('twitch-player', channel);
        this.playerMounted = true;
      }
      this.message = '';
    } catch { this.error = 'The official Twitch player could not be loaded. Check HTTPS, embed parents, and browser extensions.'; }
  }
}
