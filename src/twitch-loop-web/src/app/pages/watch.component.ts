import { CommonModule, DOCUMENT } from '@angular/common';
import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { EMPTY, Subscription, catchError, interval, startWith, switchMap } from 'rxjs';
import { ApiService, PriorityStatus, SessionState } from '../core/api.service';
import { PlayerService } from '../core/player.service';
import { WakeLockService } from '../core/wake-lock.service';

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
  private lastRevision = 0;
  private playerMounted = false;
  session: SessionState | null = null;
  chatEmbedUrl: SafeResourceUrl | null = null;
  priorityStatus: PriorityStatus = { channels: [], checkedAt: null, timeZone: 'Europe/London' };
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
    this.player.setOnPlaying(() => this.refreshFromPlayer(() => this.onPlayerPlaying()));
    this.player.setOnPlaybackBlocked(() => this.refreshFromPlayer(() => this.playbackBlocked = true));
    this.pollPriorityStatus();
    const existing = sessionStorage.getItem('twitch-loop-session');
    if (existing) this.poll(existing);
    else this.start();
  }

  start(): void {
    if (this.starting) return;
    this.starting = true;
    this.playerPlaying = false;
    this.playbackBlocked = false;
    this.error = '';
    this.changeDetector.markForCheck();
    this.api.startSession().subscribe({
      next: session => {
        this.starting = false;
        sessionStorage.setItem('twitch-loop-session', session.sessionId);
        this.apply(session);
        this.poll(session.sessionId);
        void this.wakeLock.request().then(() => this.changeDetector.markForCheck());
        this.changeDetector.markForCheck();
      },
      error: () => {
        this.starting = false;
        this.error = 'Could not start a playback session. Check the server connection.';
        this.changeDetector.markForCheck();
      }
    });
  }

  stop(): void {
    if (!this.session) return;
    const sessionId = this.session.sessionId;
    this.pollSubscription?.unsubscribe();
    sessionStorage.removeItem('twitch-loop-session');
    this.api.sessionAction(sessionId, 'stop').subscribe({
      next: state => { this.apply(state); this.player.destroy(); this.playerMounted = false; this.playerPlaying = false; this.playbackBlocked = false; void this.wakeLock.release(); this.changeDetector.markForCheck(); },
      error: () => { sessionStorage.setItem('twitch-loop-session', sessionId); this.poll(sessionId); this.error = 'Could not stop playback. Please try again.'; this.changeDetector.markForCheck(); }
    });
  }

  toggleAuto(): void {
    if (!this.session) return;
    const action = this.session.automationMode === 'paused' ? 'resumeAuto' : 'pauseAuto';
    this.api.sessionAction(this.session.sessionId, action).subscribe({ next: state => this.apply(state) });
  }

  reset(): void { this.pollSubscription?.unsubscribe(); sessionStorage.removeItem('twitch-loop-session'); this.session = null; this.chatEmbedUrl = null; this.lastRevision = 0; this.playerMounted = false; this.playerPlaying = false; this.playbackBlocked = false; this.cornerPlayer = false; this.player.destroy(); void this.wakeLock.release(); }
  playFromGesture(): void { this.playbackBlocked = false; this.player.play(); }
  toggleTheatre(): void {
    this.theatre = !this.theatre;
    this.document.body.classList.toggle('theatre-mode', this.theatre);
    this.updateCornerPlayer();
  }

  ngAfterViewInit(): void { this.updateCornerPlayer(); }

  @HostListener('window:scroll')
  onScroll(): void { this.updateCornerPlayer(); }

  @HostListener('window:resize')
  onResize(): void { this.updateCornerPlayer(); }

  ngOnDestroy(): void { this.document.body.classList.remove('theatre-mode'); this.pollSubscription?.unsubscribe(); this.statusSubscription?.unsubscribe(); this.player.setOnPlaying(null); this.player.setOnPlaybackBlocked(null); this.player.destroy(); void this.wakeLock.release(); }

  private poll(id: string): void {
    this.pollSubscription?.unsubscribe();
    this.pollSubscription = interval(15000).pipe(
      startWith(0),
      switchMap(() => this.api.currentSession(id).pipe(catchError(error => {
        if (error.status === 404) this.restartSession(id);
        else {
          this.message = 'Waiting for the local API…';
          this.changeDetector.markForCheck();
        }
        return EMPTY;
      })))
    ).subscribe(state => {
      if (state.state === 'stopped') this.restartSession(id);
      else this.apply(state);
    });
  }

  private restartSession(id: string): void {
    if (sessionStorage.getItem('twitch-loop-session') !== id) return;
    this.pollSubscription?.unsubscribe();
    sessionStorage.removeItem('twitch-loop-session');
    this.session = null;
    this.lastRevision = 0;
    this.start();
  }


  private pollPriorityStatus(): void {
    this.statusSubscription = interval(15000).pipe(
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
    if (this.session) this.session = { ...this.session, state: 'playing' };
  }

  private apply(state: SessionState): void {
    if (state.revision < this.lastRevision) return;
    const changed = state.channel !== this.session?.channel;
    if (changed) {
      this.playerPlaying = false;
      this.playbackBlocked = false;
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
      this.message = '';
      this.changeDetector.markForCheck();
    } catch {
      this.error = 'The official Twitch player could not be loaded. Check HTTPS, embed parents, and browser extensions.';
      this.changeDetector.markForCheck();
    }
  }
}
