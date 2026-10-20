import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { applyHlsVideoStyles } from '../core/hls-player';
import { PLAYER_MODE_STORAGE_KEY } from '../core/player-mode';
import { PlayerService } from '../core/player.service';
import { WakeLockService } from '../core/wake-lock.service';
import { WatchComponent } from './watch.component';

describe('WatchComponent', () => {
  const player = jasmine.createSpyObj<PlayerService>('PlayerService', ['mount', 'setOnPlaying', 'setOnPlaybackBlocked', 'getHealth', 'setChannel', 'play', 'destroy', 'setMode']);
  const wakeLock = jasmine.createSpyObj<WakeLockService>('WakeLockService', ['supported', 'active', 'request', 'release']);

  beforeEach(async () => {
    sessionStorage.clear();
    localStorage.removeItem(PLAYER_MODE_STORAGE_KEY);
    player.mount.and.returnValue(Promise.resolve());
    player.getHealth.and.returnValue(null);
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

  function flushPriorityStatus(
    http: HttpTestingController,
    channels: { login: string; isLive: boolean | null }[] = [],
    liveStreams: { login: string; name: string; viewerCount: number; startedAt: string }[] = []
  ): void {
    http.expectOne('/api/channels/priority-status').flush({ channels, liveStreams, checkedAt: '2026-10-06T05:00:00Z', timeZone: 'Europe/London' });
  }


  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    player.mount.calls.reset();
    player.setChannel.calls.reset();
    player.setOnPlaying.calls.reset();
    player.setOnPlaybackBlocked.calls.reset();
    player.getHealth.calls.reset();
    player.play.calls.reset();
    player.destroy.calls.reset();
    player.setMode.calls.reset();
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
    http.expectOne('/api/logs/playback-started').flush(null);
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


  it('recreates a stalled Twitch iframe after consecutive unhealthy playback checks', async () => {
    jasmine.clock().install();
    jasmine.clock().mockDate();
    sessionStorage.setItem('twitch-loop-session', 'health-session');
    player.getHealth.and.returnValue({ paused: false, hasPlaybackActivity: true });
    const fixture = TestBed.createComponent(WatchComponent);
    try {
      fixture.detectChanges();
      const http = TestBed.inject(HttpTestingController);
      flushPriorityStatus(http);
      const state = {
        sessionId: 'health-session', revision: 1, state: 'playing', automationMode: 'auto', channel: 'streamer',
        selectionTier: 'priority', reason: 'priority_channel_live', statusFreshness: 'fresh', pollAfterSeconds: 15,
        settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
      };
      http.expectOne('/api/sessions/health-session/current-stream').flush(state);
      await fixture.whenStable();
      http.expectNone('/api/sessions');
      const component = fixture.componentInstance as unknown as {
        pollSubscription: { unsubscribe(): void } | null;
        statusSubscription: { unsubscribe(): void } | null;
      };
      component.pollSubscription?.unsubscribe();
      component.statusSubscription?.unsubscribe();
      player.setOnPlaying.calls.mostRecent().args[0]?.();
      http.expectOne('/api/logs/playback-started').flush(null);
      await fixture.whenStable();

      player.getHealth.and.returnValue({ paused: true, hasPlaybackActivity: false });
      jasmine.clock().tick(45_000);
      expect(player.mount).toHaveBeenCalledTimes(1);
      player.getHealth.and.returnValue({ paused: false, hasPlaybackActivity: false });
      jasmine.clock().tick(30_000);
      expect(player.mount).toHaveBeenCalledTimes(1);
      jasmine.clock().tick(15_000);
      await fixture.whenStable();

      expect(player.destroy).toHaveBeenCalled();
      expect(player.mount).toHaveBeenCalledTimes(2);
    } finally {
      fixture.destroy();
      sessionStorage.removeItem('twitch-loop-session');
      jasmine.clock().uninstall();
    }
  });

  it('uses the experimental HLS player when the browser setting selects it', async () => {
    localStorage.setItem(PLAYER_MODE_STORAGE_KEY, 'hls');
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    expect(player.setMode).toHaveBeenCalledWith('hls');
    expect(fixture.componentInstance.playerMode).toBe('hls');

    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http);
    const waiting = {
      sessionId: 'mode-session', revision: 1, state: 'waiting', automationMode: 'auto', channel: null,
      selectionTier: null, reason: 'awaiting_fresh_live_status', statusFreshness: 'unknown', pollAfterSeconds: 15,
      settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    };
    http.expectOne('/api/sessions').flush(waiting);
    http.expectOne('/api/sessions/mode-session/current-stream').flush(waiting);
    await fixture.whenStable();
    fixture.destroy();
    localStorage.removeItem(PLAYER_MODE_STORAGE_KEY);
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
      jasmine.clock().tick(14999);
      expect(http.match('/api/sessions').length).toBe(0);
      jasmine.clock().tick(1);

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

  it('shows a reconnecting message on transient session failures and applies state once the backend returns', async () => {
    jasmine.clock().install();
    sessionStorage.setItem('twitch-loop-session', 'online-session');
    const fixture = TestBed.createComponent(WatchComponent);
    try {
      fixture.detectChanges();
      const http = TestBed.inject(HttpTestingController);
      flushPriorityStatus(http);
      http.expectOne('/api/sessions/online-session/current-stream').flush('Unavailable', { status: 503, statusText: 'Service Unavailable' });
      await fixture.whenStable();
      expect(fixture.nativeElement.querySelector('.notice.warning')?.textContent).toContain('Reconnecting to the server…');

      jasmine.clock().tick(15000);
      http.expectOne('/api/sessions/online-session/current-stream').flush({
        sessionId: 'online-session', revision: 1, state: 'playing', automationMode: 'auto', channel: 'online_stream',
        selectionTier: 'priority', reason: 'priority_channel_live', statusFreshness: 'fresh', pollAfterSeconds: 15,
        settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
      });
      await fixture.whenStable();
      expect(fixture.nativeElement.querySelector('.notice.warning')).toBeNull();
      expect(fixture.componentInstance.playerPlaying).toBeFalse();
      player.setOnPlaying.calls.mostRecent().args[0]?.();
      http.expectOne('/api/logs/playback-started').flush(null);
      expect(fixture.componentInstance.playbackState).toBe('playing');
    } finally {
      fixture.destroy();
      sessionStorage.removeItem('twitch-loop-session');
      jasmine.clock().uninstall();
    }
  });

  it('starts a fresh session after five minutes without a backend update', async () => {
    jasmine.clock().install();
    jasmine.clock().mockDate();
    sessionStorage.setItem('twitch-loop-session', 'stale-session');
    const fixture = TestBed.createComponent(WatchComponent);
    try {
      fixture.detectChanges();
      const http = TestBed.inject(HttpTestingController);
      flushPriorityStatus(http);
      http.expectOne('/api/sessions/stale-session/current-stream').flush({
        sessionId: 'stale-session', revision: 1, state: 'playing', automationMode: 'auto', channel: 'streamer',
        selectionTier: 'priority', reason: 'priority_channel_live', statusFreshness: 'fresh', pollAfterSeconds: 15,
        settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
      });
      await fixture.whenStable();
      const component = fixture.componentInstance as unknown as {
        pollSubscription: { unsubscribe(): void } | null;
        statusSubscription: { unsubscribe(): void } | null;
        backendUpdateTimer: ReturnType<typeof setTimeout> | null;
      };
      expect(component.backendUpdateTimer).not.toBeNull();
      component.pollSubscription?.unsubscribe();
      component.statusSubscription?.unsubscribe();

      jasmine.clock().tick(5 * 60 * 1000 - 1);
      expect(sessionStorage.getItem('twitch-loop-session')).toBe('stale-session');

      jasmine.clock().tick(1);
      http.expectOne('/api/sessions').flush({
        sessionId: 'fresh-session', revision: 1, state: 'waiting', automationMode: 'auto', channel: null,
        selectionTier: null, reason: 'awaiting_fresh_live_status', statusFreshness: 'unknown', pollAfterSeconds: 15,
        settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
      });
      http.expectOne('/api/sessions/fresh-session/current-stream').flush({
        sessionId: 'fresh-session', revision: 1, state: 'waiting', automationMode: 'auto', channel: null,
        selectionTier: null, reason: 'awaiting_fresh_live_status', statusFreshness: 'unknown', pollAfterSeconds: 15,
        settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
      });
      await fixture.whenStable();
      expect(sessionStorage.getItem('twitch-loop-session')).toBe('fresh-session');
    } finally {
      fixture.destroy();
      sessionStorage.removeItem('twitch-loop-session');
      jasmine.clock().uninstall();
    }
  });

  it('starts a fresh session when the saved session is lost (404) during poll', async () => {
    jasmine.clock().install();
    sessionStorage.setItem('twitch-loop-session', 'lost-session');
    const fixture = TestBed.createComponent(WatchComponent);
    try {
      fixture.detectChanges();
      const http = TestBed.inject(HttpTestingController);
      flushPriorityStatus(http);
      http.expectOne('/api/sessions/lost-session/current-stream').flush(null, { status: 404, statusText: 'Not Found' });
      await fixture.whenStable();

      http.expectOne('/api/sessions').flush({
        sessionId: 'fresh-session', revision: 1, state: 'waiting', automationMode: 'auto', channel: null,
        selectionTier: null, reason: 'awaiting_fresh_live_status', statusFreshness: 'unknown', pollAfterSeconds: 15,
        settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
      });
      http.expectOne('/api/sessions/fresh-session/current-stream').flush({
        sessionId: 'fresh-session', revision: 1, state: 'waiting', automationMode: 'auto', channel: null,
        selectionTier: null, reason: 'awaiting_fresh_live_status', statusFreshness: 'unknown', pollAfterSeconds: 15,
        settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
      });
      await fixture.whenStable();
      expect(sessionStorage.getItem('twitch-loop-session')).toBe('fresh-session');
    } finally {
      fixture.destroy();
      sessionStorage.removeItem('twitch-loop-session');
      jasmine.clock().uninstall();
    }
  });

  it('does not switch the player when refreshed channel casing changes only', async () => {
    jasmine.clock().install();
    sessionStorage.setItem('twitch-loop-session', 'same-channel-session');
    const fixture = TestBed.createComponent(WatchComponent);
    try {
      fixture.detectChanges();
      const http = TestBed.inject(HttpTestingController);
      flushPriorityStatus(http);
      http.expectOne('/api/sessions/same-channel-session/current-stream').flush({
        sessionId: 'same-channel-session', revision: 1, state: 'playing', automationMode: 'auto', channel: 'LiveChannel',
        selectionTier: 'priority', reason: 'priority_channel_live', statusFreshness: 'fresh', pollAfterSeconds: 15,
        settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
      });
      await fixture.whenStable();
      player.setOnPlaying.calls.mostRecent().args[0]?.();
    http.expectOne('/api/logs/playback-started').flush(null);

      jasmine.clock().tick(15000);
      http.expectOne('/api/sessions/same-channel-session/current-stream').flush({
        sessionId: 'same-channel-session', revision: 2, state: 'playing', automationMode: 'auto', channel: 'livechannel',
        selectionTier: 'priority', reason: 'priority_channel_live', statusFreshness: 'fresh', pollAfterSeconds: 15,
        settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
      });
      await fixture.whenStable();

      expect(player.setChannel).not.toHaveBeenCalled();
      expect(fixture.componentInstance.playerPlaying).toBeTrue();
    } finally {
      fixture.destroy();
      jasmine.clock().uninstall();
    }
  });

  it('recovers silently from transient poll failures without page refresh', async () => {
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
    expect(fixture.nativeElement.querySelector('.notice.warning')?.textContent).toContain('Reconnecting to the server…');

    (fixture.componentInstance as unknown as { poll(id: string): void }).poll('waiting-session');
    http.expectOne('/api/sessions/waiting-session/current-stream').flush(waiting);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.notice.warning')).toBeNull();
    expect(fixture.componentInstance.session).not.toBeNull();
    fixture.destroy();
    sessionStorage.removeItem('twitch-loop-session');
  });

  it('shows a followed-stream fallback row, Twitch chat, and configured 24-hour checked time', async () => {
    sessionStorage.setItem('twitch-loop-session', 'fallback-session');
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http, [{ login: 'priority', isLive: false }], [{ login: 'followed_stream', name: 'Followed Stream', viewerCount: 1234, startedAt: new Date(Date.now() - 3 * 60 * 60_000 - 5 * 60_000 - 5000).toISOString() }]);
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
    const chatHeading = fixture.nativeElement.querySelector('.live-chat-heading') as HTMLElement;
    expect(chatHeading.querySelector('h2')?.textContent).toContain('Live chat — Followed Stream');
    expect(chatHeading.querySelector('.stream-viewers')?.textContent).toContain('1,234 viewers');
    expect(getComputedStyle(chatHeading.querySelector('.stream-viewers') as HTMLElement).color).toBe('rgb(255, 130, 128)');
    expect(chatHeading.querySelector('.stream-duration')?.textContent).toMatch(/^03:05:\d{2}$/);
    expect(fixture.nativeElement.querySelector('.stream-summary')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Last updated');
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
    http.expectOne('/api/logs/playback-started').flush(null);
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

  it('increments the live duration locally every second without extra API calls', async () => {
    sessionStorage.setItem('twitch-loop-session', 'duration-session');
    sessionStorage.setItem('twitch-loop-theatre', 'true');
    const startedAt = new Date(Date.now() - 65 * 60_000 - 5000).toISOString();
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http, [], [{
      login: 'timer_stream', name: 'Timer Stream', viewerCount: 321,
      startedAt
    }]);
    http.expectOne('/api/sessions/duration-session/current-stream').flush({
      sessionId: 'duration-session', revision: 1, state: 'playing', automationMode: 'auto', channel: 'timer_stream',
      selectionTier: 'priority', reason: 'priority_channel_live', statusFreshness: 'fresh', pollAfterSeconds: 15,
      settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });
    await fixture.whenStable();
    fixture.detectChanges();

    const durationInSeconds = (value: string) => {
      const [hours, minutes, seconds] = value.split(':').map(Number);
      return hours * 3600 + minutes * 60 + seconds;
    };
    const readDuration = (selector: string) => (fixture.nativeElement.querySelector(selector) as HTMLElement).textContent!.trim();
    const pageDuration = readDuration('.live-chat-heading .stream-duration');
    const theatreDuration = readDuration('.theatre-exit-bar .stream-duration');
    expect(theatreDuration).toBe(pageDuration);
    await new Promise(resolve => setTimeout(resolve, 1100));
    fixture.detectChanges();
    const pageDurationAfterTick = durationInSeconds(readDuration('.live-chat-heading .stream-duration'));
    const theatreDurationAfterTick = durationInSeconds(readDuration('.theatre-exit-bar .stream-duration'));
    expect(pageDurationAfterTick).toBeGreaterThan(durationInSeconds(pageDuration));
    expect(pageDurationAfterTick).toBeLessThanOrEqual(durationInSeconds(pageDuration) + 2);
    expect(theatreDurationAfterTick).toBe(pageDurationAfterTick);
    http.expectNone('/api/channels/priority-status');
    http.expectNone('/api/sessions/duration-session/current-stream');

    fixture.destroy();
    sessionStorage.removeItem('twitch-loop-session');
    sessionStorage.removeItem('twitch-loop-theatre');
  });

  it('refreshes the live viewer count every minute', async () => {
    jasmine.clock().install();
    sessionStorage.setItem('twitch-loop-session', 'viewer-count-session');
    const fixture = TestBed.createComponent(WatchComponent);
    try {
      fixture.detectChanges();
      const http = TestBed.inject(HttpTestingController);
      const startedAt = new Date().toISOString();
      flushPriorityStatus(http, [], [{ login: 'viewer_stream', name: 'Viewer Stream', viewerCount: 321, startedAt }]);
      const session = {
        sessionId: 'viewer-count-session', revision: 1, state: 'playing', automationMode: 'auto', channel: 'viewer_stream',
        selectionTier: 'priority', reason: 'priority_channel_live', statusFreshness: 'fresh', pollAfterSeconds: 15,
        settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
      };
      http.expectOne('/api/sessions/viewer-count-session/current-stream').flush(session);
      await fixture.whenStable();
      fixture.detectChanges();
      const viewerCount = () => (fixture.nativeElement.querySelector('.live-chat-heading .stream-viewers') as HTMLElement).textContent;
      expect(viewerCount()).toContain('321 viewers');

      for (let i = 0; i < 3; i++) {
        jasmine.clock().tick(15000);
        http.expectOne('/api/sessions/viewer-count-session/current-stream').flush(session);
      }
      expect(viewerCount()).toContain('321 viewers');

      jasmine.clock().tick(15000);
      http.expectOne('/api/channels/priority-status').flush({
        channels: [],
        liveStreams: [{ login: 'viewer_stream', name: 'Viewer Stream', viewerCount: 654, startedAt }],
        checkedAt: '2026-10-06T05:01:00Z',
        timeZone: 'Europe/London'
      });
      http.expectOne('/api/sessions/viewer-count-session/current-stream').flush(session);
      fixture.detectChanges();
      expect(viewerCount()).toContain('654 viewers');
    } finally {
      fixture.destroy();
      sessionStorage.removeItem('twitch-loop-session');
      jasmine.clock().uninstall();
    }
  });

  it('fills the available theatre space and keeps a padded bottom exit bar', async () => {
    sessionStorage.setItem('twitch-loop-session', 'theatre-session');
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http, [], [{ login: 'theatre_stream', name: 'Theatre Streamer', viewerCount: 789, startedAt: new Date(Date.now() - 65 * 60_000 - 5000).toISOString() }]);
    http.expectOne('/api/sessions/theatre-session/current-stream').flush({
      sessionId: 'theatre-session', revision: 1, state: 'playing', automationMode: 'auto', channel: 'theatre_stream',
      selectionTier: 'priority', reason: 'priority_channel_live', statusFreshness: 'fresh', pollAfterSeconds: 15,
      settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });
    await fixture.whenStable();
    fixture.detectChanges();

    const theatreButton = Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
      .find(button => button.textContent?.trim() === 'Theatre mode')!;
    const playerShell = fixture.nativeElement.querySelector('.player-shell') as HTMLElement;
    const player = playerShell.querySelector('.player') as HTMLElement;
    const video = document.createElement('video');
    video.className = 'hls-player';
    applyHlsVideoStyles(video);
    player.appendChild(video);
    fixture.detectChanges();
    const playerBounds = player.getBoundingClientRect();
    const videoBounds = video.getBoundingClientRect();
    expect(videoBounds.width).toBeCloseTo(playerBounds.width, 0);
    expect(videoBounds.height).toBeCloseTo(playerBounds.height, 0);

    theatreButton.click();
    fixture.detectChanges();
    expect(playerShell.classList.contains('theatre')).toBeTrue();
    expect(getComputedStyle(playerShell).position).toBe('absolute');
    expect(parseFloat(getComputedStyle(playerShell).height)).toBeCloseTo(window.innerHeight - (fixture.nativeElement.querySelector('.theatre-exit-bar') as HTMLElement).getBoundingClientRect().height, 0);
    expect(parseFloat(getComputedStyle(playerShell).width)).toBeCloseTo(document.documentElement.clientWidth, 0);
    const theatreBounds = player.getBoundingClientRect();
    const theatreVideoBounds = video.getBoundingClientRect();
    expect(theatreVideoBounds.width).toBeCloseTo(theatreBounds.width, 0);
    expect(theatreVideoBounds.height).toBeCloseTo(theatreBounds.height, 0);
    expect(theatreVideoBounds.bottom).toBeLessThanOrEqual(playerShell.getBoundingClientRect().bottom + 1);
    expect(document.body.classList.contains('theatre-mode')).toBeTrue();
    const exitBar = fixture.nativeElement.querySelector('.theatre-exit-bar') as HTMLElement;
    expect(exitBar.textContent).toContain('Exit theatre mode');
    expect(exitBar.textContent).toContain('Theatre Streamer');
    expect(exitBar.querySelector('.stream-viewers')?.textContent).toContain('789 viewers');
    expect(getComputedStyle(exitBar.querySelector('.stream-viewers') as HTMLElement).color).toBe('rgb(255, 130, 128)');
    expect(exitBar.querySelector('.stream-duration')?.textContent).toMatch(/^01:05:\d{2}$/);
    const lastUpdated = exitBar.querySelector('.theatre-last-updated') as HTMLElement;
    expect(lastUpdated.textContent).toContain('Updated: 06:00');
    expect(lastUpdated.getBoundingClientRect().left).toBeGreaterThan(exitBar.querySelector('button')!.getBoundingClientRect().right);
    expect(parseFloat(getComputedStyle(exitBar).paddingTop)).toBeGreaterThanOrEqual(15);
    expect(parseFloat(getComputedStyle(exitBar).paddingRight)).toBeGreaterThanOrEqual(15);
    expect(parseFloat(getComputedStyle(exitBar).paddingBottom)).toBeGreaterThanOrEqual(15);
    expect(parseFloat(getComputedStyle(exitBar).paddingLeft)).toBeGreaterThanOrEqual(15);
    expect(exitBar.getBoundingClientRect().height).toBeLessThan(window.innerHeight * 0.2);
    const exitButton = exitBar.querySelector('button') as HTMLButtonElement;
    expect(exitButton.querySelector('svg')).not.toBeNull();
    const exitButtonBounds = exitButton.getBoundingClientRect();
    expect(exitButtonBounds.left + exitButtonBounds.width / 2).toBeCloseTo(window.innerWidth / 2, 0);
    expect(exitBar.querySelector('.theatre-stream-meta')?.getBoundingClientRect().right).toBeLessThan(exitButtonBounds.left);
    expect(exitBar.getBoundingClientRect().top + exitBar.getBoundingClientRect().height).toBeCloseTo(window.innerHeight, 0);
    exitButton.click();
    fixture.detectChanges();
    expect(document.body.classList.contains('theatre-mode')).toBeFalse();
    fixture.destroy();
    sessionStorage.removeItem('twitch-loop-session');
  });



  it('restores theatre mode after Watch reloads', async () => {
    sessionStorage.setItem('twitch-loop-session', 'restored-session');
    sessionStorage.setItem('twitch-loop-theatre', 'true');
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http);
    http.expectOne('/api/sessions/restored-session/current-stream').flush({
      sessionId: 'restored-session', revision: 1, state: 'waiting', automationMode: 'auto', channel: null,
      selectionTier: null, reason: 'awaiting_fresh_live_status', statusFreshness: 'unknown', pollAfterSeconds: 15,
      settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.theatre).toBeTrue();
    expect(document.body.classList.contains('theatre-mode')).toBeTrue();
    expect(fixture.nativeElement.querySelector('.player-shell').classList.contains('theatre')).toBeTrue();
    fixture.destroy();
    sessionStorage.removeItem('twitch-loop-session');
    sessionStorage.removeItem('twitch-loop-theatre');
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
    http.expectOne('/api/logs/playback-started').flush(null);
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
