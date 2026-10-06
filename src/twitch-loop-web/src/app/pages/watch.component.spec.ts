import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PlayerService } from '../core/player.service';
import { WakeLockService } from '../core/wake-lock.service';
import { WatchComponent } from './watch.component';

describe('WatchComponent', () => {
  const player = jasmine.createSpyObj<PlayerService>('PlayerService', ['mount', 'setOnPlaying', 'setOnPlaybackBlocked', 'setChannel', 'play', 'destroy']);
  const wakeLock = jasmine.createSpyObj<WakeLockService>('WakeLockService', ['supported', 'active', 'request', 'release']);

  beforeEach(async () => {
    sessionStorage.clear();
    player.mount.and.returnValue(Promise.resolve());
    wakeLock.supported.and.returnValue(true);
    wakeLock.active.and.returnValue(false);
    wakeLock.request.and.returnValue(Promise.resolve(true));
    wakeLock.release.and.returnValue(Promise.resolve());
    await TestBed.configureTestingModule({
      imports: [WatchComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: PlayerService, useValue: player },
        { provide: WakeLockService, useValue: wakeLock }
      ]
    }).compileComponents();
  });

  function flushPriorityStatus(http: HttpTestingController, channels: { login: string; isLive: boolean | null }[] = []): void {
    http.expectOne('/api/channels/priority-status').flush({ channels, checkedAt: '2026-10-06T05:00:00Z', timeZone: 'Europe/London' });
  }


  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    player.mount.calls.reset();
    player.setChannel.calls.reset();
    player.setOnPlaying.calls.reset();
    player.setOnPlaybackBlocked.calls.reset();
    player.play.calls.reset();
  });

  it('starts playback automatically on a fresh Watch visit', async () => {
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.wake-lock-pill')).toBeNull();
    const startupAlert = fixture.nativeElement.querySelector('.playback-status') as HTMLElement;
    expect(startupAlert.classList.contains('info')).toBeTrue();
    expect(startupAlert.querySelector('strong')?.textContent).toContain('stopped');
    expect(startupAlert.textContent).toContain('Starting playback automatically…');
    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http, [
      { login: 'first', isLive: false },
      { login: 'second', isLive: null },
      { login: 'third', isLive: true }
    ]);
    const scheduledSession = {
      sessionId: 'scheduled-session', revision: 2, state: 'playing', automationMode: 'auto', channel: 'second',
      selectionTier: 'priority', reason: 'priority_channel_live',
      statusFreshness: 'fresh', pollAfterSeconds: 15, settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    };
    http.expectOne('/api/sessions').flush(scheduledSession);
    http.expectOne('/api/sessions/scheduled-session/current-stream').flush(scheduledSession);
    await fixture.whenStable();

    expect(player.mount).toHaveBeenCalledWith('twitch-player', 'second');
    expect(fixture.componentInstance.starting).toBeFalse();
    expect(fixture.nativeElement.textContent).toContain('Connecting to second…');
    expect(fixture.nativeElement.textContent).not.toContain('session_started');
    expect(fixture.nativeElement.querySelector('.player-shell .player-placeholder')).toBeNull();
    expect(fixture.nativeElement.querySelector('.playback-status')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.playback-status').classList.contains('info')).toBeTrue();
    expect(fixture.nativeElement.querySelector('aside')).toBeNull();
    const selectedPriority = fixture.nativeElement.querySelector('.channel-priorities li.current') as HTMLElement;
    expect(selectedPriority.querySelector('.channel-state')?.textContent).toContain('Checking');
    player.setOnPlaying.calls.mostRecent().args[0]?.();
    await fixture.whenStable();
    expect(fixture.componentInstance.session?.state).toBe('playing');
    expect(fixture.nativeElement.querySelector('.player-placeholder')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Currently playing');
    fixture.detectChanges();
    expect(Array.from(selectedPriority.children).map(child => child.className)).toEqual(['channel-name', 'playing-indicator', 'channel-state live']);
    expect(fixture.nativeElement.textContent).toContain('Offline');
    expect(fixture.nativeElement.textContent).toContain('Live');
    expect(fixture.nativeElement.querySelector('.channel-priorities .section-heading .now-playing')).toBeNull();
    expect(selectedPriority.querySelector('.channel-state.live')?.textContent).toContain('Live');
    expect(fixture.nativeElement.querySelector('.wake-lock-pill')).toBeNull();

    expect(sessionStorage.getItem('twitch-loop-session')).toBe('scheduled-session');
    fixture.destroy();
  });


  it('retries starting playback after a transient backend failure', async () => {
    jasmine.clock().install();
    const fixture = TestBed.createComponent(WatchComponent);
    try {
      fixture.detectChanges();
      const http = TestBed.inject(HttpTestingController);
      flushPriorityStatus(http);
      http.expectOne('/api/sessions').flush('Unavailable', { status: 502, statusText: 'Bad Gateway' });
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.notice.warning')?.textContent).toContain('Reconnecting in 30 seconds.');

      jasmine.clock().tick(15000);
      flushPriorityStatus(http);
      jasmine.clock().tick(14999);
      expect(http.match('/api/sessions').length).toBe(0);
      jasmine.clock().tick(1);
      flushPriorityStatus(http);

      const waiting = {
        sessionId: 'retried-session', revision: 1, state: 'waiting', automationMode: 'auto', channel: null,
        selectionTier: null, reason: 'awaiting_fresh_live_status', statusFreshness: 'unknown', pollAfterSeconds: 15,
        settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
      };
      http.expectOne('/api/sessions').flush(waiting);
      http.expectOne('/api/sessions/retried-session/current-stream').flush(waiting);
      await fixture.whenStable();
      fixture.detectChanges();
      expect(sessionStorage.getItem('twitch-loop-session')).toBe('retried-session');
      expect(fixture.nativeElement.querySelector('.notice.warning')).toBeNull();
    } finally {
      fixture.destroy();
      jasmine.clock().uninstall();
    }
  });

  it('retries session creation immediately when browser connectivity returns', async () => {
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http);
    http.expectOne('/api/sessions').flush('Unavailable', { status: 0, statusText: 'Unknown Error' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.notice.warning')?.textContent).toContain('Reconnecting in 30 seconds.');

    window.dispatchEvent(new Event('online'));
    const waiting = {
      sessionId: 'online-retry-session', revision: 1, state: 'waiting', automationMode: 'auto', channel: null,
      selectionTier: null, reason: 'awaiting_fresh_live_status', statusFreshness: 'unknown', pollAfterSeconds: 15,
      settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    };
    http.expectOne('/api/sessions').flush(waiting);
    http.expectOne('/api/sessions/online-retry-session/current-stream').flush(waiting);
    await fixture.whenStable();
    expect(sessionStorage.getItem('twitch-loop-session')).toBe('online-retry-session');
    fixture.destroy();
  });

  it('polls a saved session immediately when browser connectivity returns', async () => {
    sessionStorage.setItem('twitch-loop-session', 'online-session');
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http);
    http.expectOne('/api/sessions/online-session/current-stream').flush('Unavailable', { status: 503, statusText: 'Service Unavailable' });
    await fixture.whenStable();

    window.dispatchEvent(new Event('online'));
    http.expectOne('/api/sessions/online-session/current-stream').flush({
      sessionId: 'online-session', revision: 1, state: 'playing', automationMode: 'auto', channel: 'online_stream',
      selectionTier: 'priority', reason: 'priority_channel_live', statusFreshness: 'fresh', pollAfterSeconds: 15,
      settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });
    flushPriorityStatus(http);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.notice.warning')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Connecting to online_stream…');
    fixture.destroy();
  });

  it('continues polling a saved session until the backend recovers', async () => {
    jasmine.clock().install();
    sessionStorage.setItem('twitch-loop-session', 'recovering-session');
    const fixture = TestBed.createComponent(WatchComponent);
    try {
      fixture.detectChanges();
      const http = TestBed.inject(HttpTestingController);
      flushPriorityStatus(http);
      http.expectOne('/api/sessions/recovering-session/current-stream').flush('Unavailable', { status: 503, statusText: 'Service Unavailable' });
      await fixture.whenStable();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.notice.warning')?.textContent).toContain('Waiting for the local API');
      expect(sessionStorage.getItem('twitch-loop-session')).toBe('recovering-session');

      jasmine.clock().tick(15000);
      flushPriorityStatus(http);
      http.expectOne('/api/sessions/recovering-session/current-stream').flush({
        sessionId: 'recovering-session', revision: 1, state: 'playing', automationMode: 'auto', channel: 'recovered_stream',
        selectionTier: 'priority', reason: 'priority_channel_live', statusFreshness: 'fresh', pollAfterSeconds: 15,
        settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
      });
      await fixture.whenStable();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.notice.warning')).toBeNull();
      expect(fixture.nativeElement.textContent).toContain('Connecting to recovered_stream…');
    } finally {
      fixture.destroy();
      jasmine.clock().uninstall();
    }
  });

  it('highlights local API waits in amber and clears the warning after recovery', async () => {
    sessionStorage.setItem('twitch-loop-session', 'waiting-session');
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http);
    const waiting = {
      sessionId: 'waiting-session', revision: 1, state: 'waiting', automationMode: 'auto', channel: null,
      selectionTier: null, reason: 'awaiting_fresh_live_status', statusFreshness: 'unknown', pollAfterSeconds: 15,
      settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    };
    http.expectOne('/api/sessions/waiting-session/current-stream').flush(waiting);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.playback-status').classList.contains('info')).toBeTrue();

    (fixture.componentInstance as unknown as { poll(id: string): void }).poll('waiting-session');
    http.expectOne('/api/sessions/waiting-session/current-stream').flush('Unavailable', { status: 502, statusText: 'Bad Gateway' });
    await fixture.whenStable();
    fixture.detectChanges();
    const warning = fixture.nativeElement.querySelector('.notice.warning') as HTMLElement;
    expect(warning.textContent).toContain('Waiting for the local API…');
    expect(warning.getAttribute('role')).toBe('status');

    (fixture.componentInstance as unknown as { poll(id: string): void }).poll('waiting-session');
    http.expectOne('/api/sessions/waiting-session/current-stream').flush(waiting);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.notice.warning')).toBeNull();
    fixture.destroy();
    sessionStorage.removeItem('twitch-loop-session');
  });

  it('shows a followed-stream fallback row, Twitch chat, and configured 24-hour checked time', async () => {
    sessionStorage.setItem('twitch-loop-session', 'fallback-session');
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http, [{ login: 'priority', isLive: false }]);
    http.expectOne('/api/sessions/fallback-session/current-stream').flush({
      sessionId: 'fallback-session', revision: 1, state: 'playing', automationMode: 'auto', channel: 'followed_stream',
      selectionTier: 'any-following', reason: 'any_following_live', statusFreshness: 'fresh', pollAfterSeconds: 15,
      settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });
    await fixture.whenStable();
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector('.fallback-channel') as HTMLElement;
    expect(row.textContent).toContain('followed_stream');
    expect(row.textContent).toContain('Randomly chosen from your live followed channels');
    expect(row.querySelector('.channel-state.live')?.textContent).toContain('Live');
    const priorityHeading = fixture.nativeElement.querySelector('.channel-priorities .section-heading') as HTMLElement;
    expect(priorityHeading.querySelector('.last-refreshed')?.textContent).toContain('Last refreshed 06:00');
    expect(priorityHeading.lastElementChild?.classList.contains('last-refreshed')).toBeTrue();
    fixture.componentInstance.priorityStatus = { ...fixture.componentInstance.priorityStatus, checkedAt: '2026-10-06T23:30:00Z' };
    expect(fixture.componentInstance.formatLastChecked()).toBe('00:30');
    fixture.componentInstance.priorityStatus = { ...fixture.componentInstance.priorityStatus, checkedAt: '2026-10-06T05:00:00Z', timeZone: 'America/Los_Angeles' };
    expect(fixture.componentInstance.formatLastChecked()).toBe('22:00');
    const chat = fixture.nativeElement.querySelector('.live-chat iframe') as HTMLIFrameElement;
    expect(chat.getAttribute('src')).toContain('https://www.twitch.tv/embed/followed_stream/chat?darkpopout&parent=localhost');
    expect(fixture.nativeElement.querySelector('.player-shell .playback-status')).toBeNull();

    player.setOnPlaying.calls.mostRecent().args[0]?.();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.fallback-channel .playing-indicator')?.textContent).toContain('Currently playing');
    fixture.destroy();
    sessionStorage.removeItem('twitch-loop-session');
  });

  it('labels the Twitch-wide any fallback distinctly from followed-channel fallback', async () => {
    sessionStorage.setItem('twitch-loop-session', 'any-fallback-session');
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http);
    http.expectOne('/api/sessions/any-fallback-session/current-stream').flush({
      sessionId: 'any-fallback-session', revision: 1, state: 'playing', automationMode: 'auto', channel: 'global_stream',
      selectionTier: 'any', reason: 'any_twitch_live', statusFreshness: 'fresh', pollAfterSeconds: 15,
      settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.fallback-channel').textContent).toContain('Randomly chosen from Twitch live channels');
    fixture.destroy();
    sessionStorage.removeItem('twitch-loop-session');
  });


  it('uses a full-width 90-percent theatre player and reserves the bottom for exit controls', async () => {
    sessionStorage.setItem('twitch-loop-session', 'theatre-session');
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http);
    http.expectOne('/api/sessions/theatre-session/current-stream').flush({
      sessionId: 'theatre-session', revision: 1, state: 'waiting', automationMode: 'auto', channel: null,
      selectionTier: null, reason: 'awaiting_fresh_live_status', statusFreshness: 'unknown', pollAfterSeconds: 15,
      settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });
    await fixture.whenStable();
    fixture.detectChanges();

    const theatreButton = Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
      .find(button => button.textContent?.trim() === 'Theatre mode')!;
    theatreButton.click();
    fixture.detectChanges();
    const playerShell = fixture.nativeElement.querySelector('.player-shell') as HTMLElement;
    expect(playerShell.classList.contains('theatre')).toBeTrue();
    expect(getComputedStyle(playerShell).position).toBe('fixed');
    expect(parseFloat(getComputedStyle(playerShell).height)).toBeCloseTo(window.innerHeight * 0.9, 0);
    expect(parseFloat(getComputedStyle(playerShell).width)).toBeCloseTo(window.innerWidth, 0);
    expect(document.body.classList.contains('theatre-mode')).toBeTrue();
    const exitBar = fixture.nativeElement.querySelector('.theatre-exit-bar') as HTMLElement;
    expect(exitBar.textContent).toContain('Exit theatre mode');
    expect(parseFloat(getComputedStyle(exitBar).height)).toBeCloseTo(window.innerHeight * 0.1, 0);
    const exitButton = exitBar.querySelector('button') as HTMLButtonElement;
    expect(exitButton.querySelector('svg')).not.toBeNull();
    const exitButtonBounds = exitButton.getBoundingClientRect();
    expect(exitButtonBounds.left + exitButtonBounds.width / 2).toBeCloseTo(document.documentElement.clientWidth / 2, 0);
    exitButton.click();
    fixture.detectChanges();
    expect(document.body.classList.contains('theatre-mode')).toBeFalse();
    fixture.destroy();
    sessionStorage.removeItem('twitch-loop-session');
  });



  it('automatically starts a fresh session when the saved session is stopped', async () => {
    sessionStorage.setItem('twitch-loop-session', 'stopped-session');
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http);
    http.expectOne('/api/sessions/stopped-session/current-stream').flush({
      sessionId: 'stopped-session', revision: 3, state: 'stopped', automationMode: 'auto', channel: null,
      selectionTier: null, reason: 'session_stopped', statusFreshness: 'unknown', pollAfterSeconds: 15,
      settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });

    const start = http.expectOne('/api/sessions');
    start.flush({
      sessionId: 'new-session', revision: 1, state: 'waiting', automationMode: 'auto', channel: null,
      selectionTier: null, reason: 'awaiting_fresh_live_status', statusFreshness: 'unknown', pollAfterSeconds: 15,
      settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });
    http.expectOne('/api/sessions/new-session/current-stream').flush({
      sessionId: 'new-session', revision: 1, state: 'waiting', automationMode: 'auto', channel: null,
      selectionTier: null, reason: 'awaiting_fresh_live_status', statusFreshness: 'unknown', pollAfterSeconds: 15,
      settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });
    await fixture.whenStable();

    expect(sessionStorage.getItem('twitch-loop-session')).toBe('new-session');
    expect(fixture.componentInstance.starting).toBeFalse();
    expect(fixture.nativeElement.textContent).not.toContain('session_started');
    fixture.destroy();
  });

  it('explains blocked autoplay and offers a playback gesture', async () => {
    sessionStorage.setItem('twitch-loop-session', 'playback-session');
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http);
    http.expectOne('/api/sessions/playback-session/current-stream').flush({
      sessionId: 'playback-session', revision: 1, state: 'playing', automationMode: 'auto', channel: 'yogscast',
      selectionTier: 'priority', reason: 'session_started', statusFreshness: 'fresh', pollAfterSeconds: 15,
      settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });
    await fixture.whenStable();

    player.setOnPlaybackBlocked.calls.mostRecent().args[0]?.();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Your browser blocked unmuted autoplay');
    expect(fixture.nativeElement.querySelector('.playback-status').classList.contains('warning')).toBeTrue();
    const playButton = fixture.nativeElement.querySelector('.playback-status button') as HTMLButtonElement;
    playButton.click();
    expect(player.play).toHaveBeenCalled();

    player.setOnPlaying.calls.mostRecent().args[0]?.();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.player-placeholder')).toBeNull();
    expect(fixture.componentInstance.playbackState).toBe('playing');
    fixture.destroy();
  });


  it('keeps the active player visible in a top-right corner and restores it at its anchor', async () => {
    sessionStorage.setItem('twitch-loop-session', 'corner-session');
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http);
    http.expectOne('/api/sessions/corner-session/current-stream').flush({
      sessionId: 'corner-session', revision: 1, state: 'playing', automationMode: 'auto', channel: 'streamer',
      selectionTier: 'priority', reason: 'priority_channel_live', statusFreshness: 'fresh', pollAfterSeconds: 15,
      settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });
    await fixture.whenStable();
    fixture.detectChanges();

    const anchor = fixture.nativeElement.querySelector('.player-anchor') as HTMLElement;
    const shell = fixture.nativeElement.querySelector('.player-shell') as HTMLElement;
    const anchorTop = anchor.getBoundingClientRect().top;
    anchor.style.position = 'relative';
    anchor.style.top = `${-anchorTop - 1}px`;
    fixture.componentInstance.onScroll();
    fixture.detectChanges();
    expect(shell.classList.contains('corner-player')).toBeTrue();
    expect(getComputedStyle(shell).position).toBe('fixed');
    expect(getComputedStyle(shell).width).toBe('400px');
    expect(getComputedStyle(shell).height).toBe('226px');

    anchor.style.top = '0px';
    fixture.componentInstance.onScroll();
    fixture.detectChanges();
    expect(shell.classList.contains('corner-player')).toBeFalse();
    fixture.destroy();
    sessionStorage.removeItem('twitch-loop-session');
  });

  it('keeps playback actions icon-labeled and omits redundant channel and player controls', async () => {
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http);
    const waitingSession = {
      sessionId: 'controls-session', revision: 1, state: 'waiting', automationMode: 'auto', channel: null,
      selectionTier: null, reason: 'awaiting_fresh_live_status',
      statusFreshness: 'unknown', pollAfterSeconds: 15, settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    };
    http.expectOne('/api/sessions').flush(waitingSession);
    http.expectOne('/api/sessions/controls-session/current-stream').flush(waitingSession);
    await fixture.whenStable();
    fixture.detectChanges();

    const buttons = Array.from(fixture.nativeElement.querySelectorAll('.control-buttons button') as NodeListOf<HTMLButtonElement>);
    expect(buttons.map(button => button.textContent?.trim())).toEqual(['Start', 'Stop', 'Pause Auto', 'Reset Session', 'Theatre mode']);
    expect(buttons.every(button => button.querySelector('svg'))).toBeTrue();
    expect(fixture.nativeElement.querySelector('.manual-channel')).toBeNull();
    expect(fixture.nativeElement.querySelector('.volume')).toBeNull();
    expect(fixture.nativeElement.querySelector('input[type="range"]')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Fullscreen');
    fixture.destroy();
  });
});
