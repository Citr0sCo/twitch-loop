import { CommonModule, DOCUMENT } from '@angular/common';
import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { EMPTY, Subscription, catchError, interval, startWith, switchMap } from 'rxjs';
import { ApiService, PriorityStatus, SessionState } from '../core/api.service';
import { PlayerService } from '../core/player.service';
import { WakeLockService } from '../core/wake-lock.service';

const playerHealthIntervalMs = 15000;
const playerStartTimeoutMs = 90000;
const unhealthySamplesBeforeRecovery = 3;
const maxPlayerRecoveryAttempts = 3;
const backendUpdateStorageKey = 'twitch-loop-last-backend-update';
const backendUpdateTimeoutMs = 5 * 60 * 1000;

@Component({ selector: 'tl-watch', standalone: true, imports: [CommonModule], templateUrl: './watch.component.html', styleUrl: './watch.component.scss' })
export class WatchComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('playerAnchor') private playerAnchor?: ElementRef<HTMLElement>;
  private readonly api = inject(ApiService);
  private readonly player = inject(PlayerService);
  private readonly wakeLock = inject(WakeLockService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly document = inject(DOCUMENT);
  private readonly sanitizer = inject(DomSanitizer);
  private pollSubscription: Subscription | null = null;
  private statusSubscription: Subscription | null = null;
  private durationSubscription: Subscription | null = null;
  private startSubscription: Subscription | null = null;
  private startRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private backendUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private playerHealthSubscription: Subscription | null = null;
  private recoverySubscription: Subscription | null = null;
  private playerMountedAt = 0;
  private unhealthyPlayerSamples = 0;
  private playerRecoveryAttempts = 0;
  private playerRecoveryExhausted = false;
  private durationNow = Date.now();
  private lastRevision = 0;
  private playerMounted = false;
  private lastLoggedPlayingChannel: string | null = null;
  session: SessionState | null = null;
  chatEmbedUrl: SafeResourceUrl | null = null;
  priorityStatus: PriorityStatus = { channels: [], liveStreams: [], checkedAt: null, timeZone: 'Europe/London' };
  playerPlaying = false;
  playbackBlocked = false;
  starting = false;
  theatre = false;
  cornerPlayer = false;
  message = '';
  error = '';

  get playbackState(): string {
    if (this.playerPlaying) return 'playing';
    if (this.playbackBlocked) return 'playback blocked';
    return this.session?.channel ? 'connecting' : this.session?.state || 'stopped';
  }

  get currentLiveStream(): PriorityStatus['liveStreams'][number] | null {
    const channel = this.session?.channel?.toLowerCase();
    return channel ? this.priorityStatus.liveStreams.find(stream => stream.login.toLowerCase() === channel) ?? null : null;
  }

  formatLiveDuration(): string | null {
    const startedAt = this.currentLiveStream?.startedAt;
    if (!startedAt) return null;
    const elapsedSeconds = Math.floor((this.durationNow - new Date(startedAt).getTime()) / 1000);
    if (!Number.isFinite(elapsedSeconds)) return null;
    const totalSeconds = Math.max(0, elapsedSeconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':');
  }

  get isFallbackStream(): boolean {
    return !!this.session?.channel && (this.session.selectionTier === 'any-following' || this.session.selectionTier === 'any');
  }

  get fallbackDescription(): string {
    return this.session?.selectionTier === 'any-following'
      ? 'Randomly chosen from your live followed channels'
      : 'Randomly chosen from Twitch live channels';
  }

  channelDisplayState(channel: PriorityStatus['channels'][number]): 'live' | 'offline' | 'checking' {
    if (this.playerPlaying && this.session?.channel?.toLowerCase() === channel.login.toLowerCase()) return 'live';
    return channel.isLive === true ? 'live' : channel.isLive === false ? 'offline' : 'checking';
  }


  get playbackMessage(): string {
    if (this.playbackBlocked) return 'Your browser blocked unmuted autoplay. Press Play to start the stream with audio.';
    if (this.session?.channel) return `Connecting to ${this.session.channel}…`;
    if (this.session?.state === 'waiting') return 'Waiting for a live candidate.';
    if (this.session?.state === 'stopped') return 'Playback was stopped.';
    return 'Starting playback automatically…';
  }

  formatLastChecked(): string | null {
    if (!this.priorityStatus.checkedAt) return null;
    const date = new Date(this.priorityStatus.checkedAt);
    try {
      return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: this.priorityStatus.timeZone }).format(date);
    } catch {
      return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).format(date);
    }
  }

  ngOnInit(): void {
    this.durationSubscription = interval(1000).subscribe(() => {
      this.durationNow = Date.now();
      this.changeDetector.markForCheck();
    });
    this.playerHealthSubscription = interval(playerHealthIntervalMs).subscribe(() => this.checkPlayerHealth());
    this.player.setOnPlaying(() => this.refreshFromPlayer(() => this.onPlayerPlaying()));
    this.player.setOnPlaybackBlocked(() => this.refreshFromPlayer(() => this.playbackBlocked = true));
    this.theatre = sessionStorage.getItem('twitch-loop-theatre') === 'true';
    this.document.body.classList.toggle('theatre-mode', this.theatre);
    this.pollPriorityStatus();
    const recovery = sessionStorage.getItem('twitch-loop-recovery-session');
    const existing = sessionStorage.getItem('twitch-loop-session');
    if (recovery) this.stopAndStartSession(recovery);
    else if (existing) {
      this.scheduleBackendUpdateTimeout(existing);
      this.poll(existing);
    } else this.start();
  }

  start(): void {
    if (this.starting) return;
    this.clearStartRetry();
    this.starting = true;
    this.playerPlaying = false;
    this.playbackBlocked = false;
    this.error = '';
    this.message = '';
    this.changeDetector.markForCheck();
    this.startSubscription = this.api.startSession().subscribe({
      next: session => {
        this.startSubscription = null;
        this.starting = false;
        sessionStorage.setItem('twitch-loop-session', session.sessionId);
        this.apply(session);
        this.poll(session.sessionId);
        void this.wakeLock.request().then(() => this.changeDetector.markForCheck());
        this.changeDetector.markForCheck();
      },
      error: error => {
        this.startSubscription = null;
        this.starting = false;
        if (this.isTransientApiFailure(error.status)) {
          this.message = 'Waiting for the local API… Reconnecting in 30 seconds.';
          this.scheduleStartRetry();
        } else {
          this.error = 'Could not start a playback session. Check the server connection.';
        }
        this.changeDetector.markForCheck();
      }
    });
  }

  private isTransientApiFailure(status: number): boolean {
    return status === 0 || status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
  }

  private scheduleStartRetry(): void {
    if (this.startRetryTimer !== null) return;
    this.startRetryTimer = setTimeout(() => {
      this.startRetryTimer = null;
      this.start();
    }, 30000);
  }

  private clearStartRetry(): void {
    if (this.startRetryTimer !== null) clearTimeout(this.startRetryTimer);
    this.startRetryTimer = null;
  }

  stop(): void {
    if (!this.session) return;
    const sessionId = this.session.sessionId;
    this.clearBackendUpdateTimeout();
    sessionStorage.removeItem(backendUpdateStorageKey);
    this.pollSubscription?.unsubscribe();
    sessionStorage.removeItem('twitch-loop-session');
    this.api.sessionAction(sessionId, 'stop').subscribe({
      next: state => { this.apply(state); this.player.destroy(); this.playerMounted = false; this.playerPlaying = false; this.playbackBlocked = false; void this.wakeLock.release(); this.changeDetector.markForCheck(); },
      error: () => { sessionStorage.setItem('twitch-loop-session', sessionId); this.scheduleBackendUpdateTimeout(sessionId); this.poll(sessionId); this.error = 'Could not stop playback. Please try again.'; this.changeDetector.markForCheck(); }
    });
  }

  toggleAuto(): void {
    if (!this.session) return;
    const action = this.session.automationMode === 'paused' ? 'resumeAuto' : 'pauseAuto';
    this.api.sessionAction(this.session.sessionId, action).subscribe({ next: state => this.apply(state) });
  }

  reset(): void { this.clearStartRetry(); this.clearRecoveryRetry(); this.clearBackendUpdateTimeout(); this.recoverySubscription?.unsubscribe(); this.recoverySubscription = null; sessionStorage.removeItem('twitch-loop-recovery-session'); sessionStorage.removeItem(backendUpdateStorageKey); this.startSubscription?.unsubscribe(); this.startSubscription = null; this.starting = false; this.pollSubscription?.unsubscribe(); sessionStorage.removeItem('twitch-loop-session'); this.session = null; this.chatEmbedUrl = null; this.lastRevision = 0; this.playerMounted = false; this.playerPlaying = false; this.playbackBlocked = false; this.cornerPlayer = false; this.message = ''; this.error = ''; this.player.destroy(); void this.wakeLock.release(); }
  playFromGesture(): void { this.playbackBlocked = false; this.player.play(); }
  toggleTheatre(): void {
    this.theatre = !this.theatre;
    sessionStorage.setItem('twitch-loop-theatre', String(this.theatre));
    this.document.body.classList.toggle('theatre-mode', this.theatre);
    this.updateCornerPlayer();
  }

  ngAfterViewInit(): void { this.updateCornerPlayer(); }

  @HostListener('window:scroll')
  onScroll(): void { this.updateCornerPlayer(); }

  @HostListener('window:resize')
  onResize(): void { this.updateCornerPlayer(); }

  @HostListener('window:online')
  onConnectionRestored(): void {
    if (this.starting) return;
    if (this.startRetryTimer !== null) {
      this.clearStartRetry();
      this.start();
      return;
    }
    const sessionId = sessionStorage.getItem('twitch-loop-session');
    if (sessionId) this.poll(sessionId);
    this.pollPriorityStatus();
  }

  ngOnDestroy(): void {
    this.document.body.classList.remove('theatre-mode');
    this.clearStartRetry();
    this.clearRecoveryRetry();
    this.clearBackendUpdateTimeout();
    this.recoverySubscription?.unsubscribe();
    this.recoverySubscription = null;
    this.startSubscription?.unsubscribe();
    this.pollSubscription?.unsubscribe();
    this.statusSubscription?.unsubscribe();
    this.durationSubscription?.unsubscribe();
    this.playerHealthSubscription?.unsubscribe();
    this.player.setOnPlaying(null);
    this.player.setOnPlaybackBlocked(null);
    this.player.destroy();
    void this.wakeLock.release();
  }

  private poll(id: string): void {
    this.pollSubscription?.unsubscribe();
    this.pollSubscription = interval(15000).pipe(
      startWith(0),
      switchMap(() => this.api.currentSession(id).pipe(catchError(error => {
        if (error.status === 404) {
          sessionStorage.setItem('twitch-loop-recovery-session', id);
          this.refreshBrowser();
        } else if (this.isTransientApiFailure(error.status)) this.reloadForRecovery(id);
        else {
          this.message = 'Could not refresh the playback session.';
          this.changeDetector.markForCheck();
        }
        return EMPTY;
      })))
    ).subscribe(state => {
      if (sessionStorage.getItem('twitch-loop-recovery-session') === id) { this.refreshBrowser(); return; }
      if (state.state === 'stopped') this.restartSession(id);
      else this.apply(state);
    });
  }

  private reloadForRecovery(id: string): void {
    if (sessionStorage.getItem('twitch-loop-recovery-session') === id) return;
    sessionStorage.setItem('twitch-loop-recovery-session', id);
    this.message = 'Waiting for the local API… The page will refresh when it reconnects.';
    this.changeDetector.markForCheck();
  }

  private refreshBrowser(): void {
    this.document.defaultView?.location.reload();
  }

  private stopAndStartSession(id: string): void {
    if (this.recoverySubscription) return;
    this.clearRecoveryRetry();
    this.message = 'Reconnecting to the local API…';
    this.recoverySubscription = this.api.sessionAction(id, 'stop').subscribe({
      next: () => { this.recoverySubscription = null; this.finishSessionRecovery(id); },
      error: error => {
        this.recoverySubscription = null;
        if (error.status === 404) this.finishSessionRecovery(id);
        else if (this.isTransientApiFailure(error.status)) {
          this.message = 'Waiting for the local API… Reconnecting in 30 seconds.';
          this.recoveryRetryTimer = setTimeout(() => {
            this.recoveryRetryTimer = null;
            this.stopAndStartSession(id);
          }, 30000);
        } else {
          this.error = 'Could not recover the playback session. Check the server connection.';
        }
        this.changeDetector.markForCheck();
      }
    });
  }

  private finishSessionRecovery(id: string): void {
    if (sessionStorage.getItem('twitch-loop-recovery-session') !== id) return;
    this.clearRecoveryRetry();
    this.clearBackendUpdateTimeout();
    sessionStorage.removeItem('twitch-loop-recovery-session');
    sessionStorage.removeItem(backendUpdateStorageKey);
    if (sessionStorage.getItem('twitch-loop-session') === id) sessionStorage.removeItem('twitch-loop-session');
    this.pollSubscription?.unsubscribe();
    this.session = null;
    this.chatEmbedUrl = null;
    this.lastRevision = 0;
    this.playerMounted = false;
    this.playerPlaying = false;
    this.playbackBlocked = false;
    this.player.destroy();
    void this.wakeLock.release();
    this.start();
  }

  private clearRecoveryRetry(): void {
    if (this.recoveryRetryTimer !== null) clearTimeout(this.recoveryRetryTimer);
    this.recoveryRetryTimer = null;
  }

  private clearBackendUpdateTimeout(): void {
    if (this.backendUpdateTimer !== null) clearTimeout(this.backendUpdateTimer);
    this.backendUpdateTimer = null;
  }

  private markBackendUpdate(sessionId: string): void {
    if (sessionStorage.getItem('twitch-loop-session') !== sessionId) {
      this.clearBackendUpdateTimeout();
      return;
    }
    sessionStorage.setItem(backendUpdateStorageKey, String(Date.now()));
    this.scheduleBackendUpdateTimeout(sessionId);
  }

  private scheduleBackendUpdateTimeout(sessionId: string): void {
    this.clearBackendUpdateTimeout();
    if (sessionStorage.getItem('twitch-loop-session') !== sessionId) return;
    let lastUpdateAt = Number(sessionStorage.getItem(backendUpdateStorageKey) ?? NaN);
    if (!Number.isFinite(lastUpdateAt)) {
      lastUpdateAt = Date.now();
      sessionStorage.setItem(backendUpdateStorageKey, String(lastUpdateAt));
    }
    this.backendUpdateTimer = setTimeout(() => {
      this.backendUpdateTimer = null;
      if (sessionStorage.getItem('twitch-loop-session') !== sessionId) return;
      const currentLastUpdateAt = Number(sessionStorage.getItem(backendUpdateStorageKey) ?? NaN);
      if (Number.isFinite(currentLastUpdateAt) && Date.now() - currentLastUpdateAt < backendUpdateTimeoutMs) {
        this.scheduleBackendUpdateTimeout(sessionId);
        return;
      }
      sessionStorage.setItem('twitch-loop-recovery-session', sessionId);
      this.refreshBrowser();
    }, Math.max(0, lastUpdateAt + backendUpdateTimeoutMs - Date.now()));
  }

  private restartSession(id: string): void {
    if (sessionStorage.getItem('twitch-loop-session') !== id) return;
    this.clearBackendUpdateTimeout();
    sessionStorage.removeItem(backendUpdateStorageKey);
    this.pollSubscription?.unsubscribe();
    sessionStorage.removeItem('twitch-loop-session');
    this.session = null;
    this.lastRevision = 0;
    this.start();
  }


  private checkPlayerHealth(): void {
    if (!this.playerMounted || !this.session?.channel || this.playbackBlocked || this.playerRecoveryExhausted) return;
    const health = this.player.getHealth();
    if (health?.paused) {
      this.unhealthyPlayerSamples = 0;
      return;
    }
    if (!this.playerPlaying) {
      if (this.playerMountedAt && Date.now() - this.playerMountedAt >= playerStartTimeoutMs) this.recoverPlayer();
      return;
    }
    if (health?.hasPlaybackActivity) {
      this.unhealthyPlayerSamples = 0;
      this.playerRecoveryAttempts = 0;
      this.playerRecoveryExhausted = false;
      return;
    }
    this.unhealthyPlayerSamples++;
    if (this.unhealthyPlayerSamples >= unhealthySamplesBeforeRecovery) this.recoverPlayer();
  }

  private recoverPlayer(): void {
    if (this.playerRecoveryAttempts >= maxPlayerRecoveryAttempts) {
      this.playerRecoveryExhausted = true;
      this.error = 'The Twitch player is still not responding after several reconnect attempts. Try Reset Session.';
      this.changeDetector.markForCheck();
      return;
    }
    const channel = this.session?.channel;
    if (!channel) return;
    this.playerRecoveryAttempts++;
    this.playerMounted = false;
    this.playerMountedAt = 0;
    this.unhealthyPlayerSamples = 0;
    this.playerPlaying = false;
    this.message = `The Twitch player stopped responding. Reconnecting to ${channel}…`;
    this.player.destroy();
    void this.wakeLock.release();
    this.changeDetector.markForCheck();
    void this.mountOrSwitch(channel);
  }

  private pollPriorityStatus(): void {
    this.statusSubscription?.unsubscribe();
    this.statusSubscription = interval(60000).pipe(
      startWith(0),
      switchMap(() => this.api.priorityStatus().pipe(catchError(() => EMPTY)))
    ).subscribe(status => {
      this.priorityStatus = status;
      this.changeDetector.markForCheck();
    });
  }

  private refreshFromPlayer(update: () => void): void {
    update();
    this.changeDetector.markForCheck();
  }

  private onPlayerPlaying(): void {
    this.playerPlaying = true;
    this.playbackBlocked = false;
    this.starting = false;
    this.error = '';
    this.message = '';
    this.unhealthyPlayerSamples = 0;
    this.playerRecoveryAttempts = 0;
    this.playerRecoveryExhausted = false;
    if (this.session) {
      this.session = { ...this.session, state: 'playing' };
      if (this.session.channel && this.lastLoggedPlayingChannel?.toLowerCase() !== this.session.channel.toLowerCase()) {
        this.lastLoggedPlayingChannel = this.session.channel;
        this.api.playbackStarted(this.session.sessionId, this.session.channel).subscribe({ error: () => undefined });
      }
    }
  }

  private apply(state: SessionState): void {
    this.markBackendUpdate(state.sessionId);
    if (state.revision < this.lastRevision) return;
    this.message = '';
    const changed = state.channel?.toLowerCase() !== this.session?.channel?.toLowerCase();
    if (changed) {
      this.playerPlaying = false;
      this.playbackBlocked = false;
      this.playerMountedAt = 0;
      this.unhealthyPlayerSamples = 0;
      this.playerRecoveryAttempts = 0;
      this.playerRecoveryExhausted = false;
      this.lastLoggedPlayingChannel = null;
    }
    this.lastRevision = state.revision; this.session = state;
    if (changed) this.chatEmbedUrl = state.channel ? this.createChatEmbedUrl(state.channel) : null;
    if (state.channel && changed) void this.mountOrSwitch(state.channel);
    this.updateCornerPlayer();
    this.changeDetector.markForCheck();
  }

  private updateCornerPlayer(): void {
    const bounds = this.playerAnchor?.nativeElement.getBoundingClientRect();
    const shouldFloat = !this.theatre && !!this.session?.channel && !!bounds && bounds.top < 0;
    if (shouldFloat === this.cornerPlayer) return;
    this.cornerPlayer = shouldFloat;
    this.changeDetector.markForCheck();
  }



  private createChatEmbedUrl(channel: string): SafeResourceUrl {
    const url = new URL(`https://www.twitch.tv/embed/${encodeURIComponent(channel)}/chat`);
    url.searchParams.set('parent', this.document.location.hostname);
    url.search = `?darkpopout&${url.searchParams.toString()}`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url.toString());
  }

  private async mountOrSwitch(channel: string): Promise<void> {
    try {
      if (this.playerMounted) this.player.setChannel(channel);
      else {
        await this.player.mount('twitch-player', channel);
        this.playerMounted = true;
      }
      this.playerMountedAt = Date.now();
      this.unhealthyPlayerSamples = 0;
      this.message = '';
      this.changeDetector.markForCheck();
    } catch {
      this.error = 'The official Twitch player could not be loaded. Check HTTPS, embed parents, and browser extensions.';
      this.changeDetector.markForCheck();
    }
  }
}
