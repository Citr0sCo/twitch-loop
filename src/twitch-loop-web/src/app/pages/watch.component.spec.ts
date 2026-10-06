import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PlayerService } from '../core/player.service';
import { WakeLockService } from '../core/wake-lock.service';
import { WatchComponent } from './watch.component';

describe('WatchComponent', () => {
  const player = jasmine.createSpyObj<PlayerService>('PlayerService', ['mount', 'setOnPlaying', 'setOnPlaybackBlocked', 'setChannel', 'setVolume', 'setMuted', 'requestFullscreen', 'pause', 'play', 'destroy']);
  const wakeLock = jasmine.createSpyObj<WakeLockService>('WakeLockService', ['supported', 'active', 'request', 'release']);

  beforeEach(async () => {
    sessionStorage.clear();
    player.mount.and.returnValue(Promise.resolve());
    player.requestFullscreen.and.returnValue(Promise.resolve());
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
    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http, [
      { login: 'first', isLive: false },
      { login: 'second', isLive: true },
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
    expect(fixture.componentInstance.muted).toBeTrue();
    expect(fixture.componentInstance.starting).toBeFalse();
    expect(fixture.nativeElement.textContent).toContain('Connecting to second…');
    expect(fixture.nativeElement.textContent).not.toContain('session_started');
    expect(fixture.nativeElement.querySelector('.player-shell .player-placeholder')).toBeNull();
    expect(fixture.nativeElement.querySelector('.playback-status')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('aside')).toBeNull();
    player.setOnPlaying.calls.mostRecent().args[0]?.();
    await fixture.whenStable();
    expect(fixture.componentInstance.session?.state).toBe('playing');
    expect(fixture.nativeElement.querySelector('.player-placeholder')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Currently playing');
    expect(fixture.nativeElement.textContent).toContain('Offline');
    expect(fixture.nativeElement.textContent).toContain('Live');
    expect(sessionStorage.getItem('twitch-loop-session')).toBe('scheduled-session');
    fixture.destroy();
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
    expect(fixture.nativeElement.querySelector('.channel-priorities').textContent).toContain('Last checked 06:00');
    fixture.componentInstance.priorityStatus = { ...fixture.componentInstance.priorityStatus, checkedAt: '2026-10-06T23:30:00Z' };
    expect(fixture.componentInstance.formatLastChecked()).toBe('00:30');
    fixture.componentInstance.priorityStatus = { ...fixture.componentInstance.priorityStatus, checkedAt: '2026-10-06T05:00:00Z', timeZone: 'America/Los_Angeles' };
    expect(fixture.componentInstance.formatLastChecked()).toBe('22:00');
    const chat = fixture.nativeElement.querySelector('.live-chat iframe') as HTMLIFrameElement;
    expect(chat.getAttribute('src')).toContain('https://www.twitch.tv/embed/followed_stream/chat?parent=localhost');
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
    expect(fixture.nativeElement.textContent).toContain('Your browser blocked autoplay');
    const playButton = fixture.nativeElement.querySelector('.playback-status button') as HTMLButtonElement;
    playButton.click();
    expect(player.play).toHaveBeenCalled();

    player.setOnPlaying.calls.mostRecent().args[0]?.();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.player-placeholder')).toBeNull();
    expect(fixture.componentInstance.playbackState).toBe('playing');
    fixture.destroy();
  });


  it('starts a session and mounts a manually selected live channel', async () => {
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http);
    component.manualChannel = ' yogscast ';
    component.selectChannel();

    const start = http.expectOne('/api/sessions');
    expect(start.request.method).toBe('POST');
    start.flush({
      sessionId: 'session-1', revision: 1, state: 'waiting', automationMode: 'auto', channel: null,
      selectionTier: null, reason: 'awaiting_fresh_live_status',
      statusFreshness: 'unknown', pollAfterSeconds: 15, settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });

    http.expectOne('/api/sessions/session-1/current-stream').flush({
      sessionId: 'session-1', revision: 1, state: 'waiting', automationMode: 'auto', channel: null,
      selectionTier: null, reason: 'awaiting_fresh_live_status',
      statusFreshness: 'unknown', pollAfterSeconds: 15, settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });

    const action = http.expectOne('/api/sessions/session-1/actions');
    expect(action.request.body).toEqual({ name: 'selectChannel', channel: 'yogscast' });
    action.flush({
      sessionId: 'session-1', revision: 2, state: 'selected', automationMode: 'manual', channel: 'yogscast',
      selectionTier: 'manual', reason: 'session_started',
      statusFreshness: 'unknown', pollAfterSeconds: 15, settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });
    await fixture.whenStable();

    expect(player.mount).toHaveBeenCalledWith('twitch-player', 'yogscast');
    expect(component.manualChannel).toBe('');
  });

  it('switches an active session to a normalized manual channel', async () => {
    sessionStorage.setItem('twitch-loop-session', 'session-2');
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http);
    http.expectOne('/api/sessions/session-2/current-stream').flush({
      sessionId: 'session-2', revision: 1, state: 'selected', automationMode: 'auto', channel: 'oldchannel',
      selectionTier: 'priority', reason: 'priority_channel_live',
      statusFreshness: 'fresh', pollAfterSeconds: 15, settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });
    await fixture.whenStable();

    component.manualChannel = ' @Yogscast ';
    component.selectChannel();

    const action = http.expectOne('/api/sessions/session-2/actions');
    expect(action.request.body).toEqual({ name: 'selectChannel', channel: 'yogscast' });
    action.flush({
      sessionId: 'session-2', revision: 2, state: 'selected', automationMode: 'manual', channel: 'yogscast',
      selectionTier: 'manual', reason: 'session_started',
      statusFreshness: 'unknown', pollAfterSeconds: 15, settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });
    await fixture.whenStable();

    expect(player.setChannel).toHaveBeenCalledWith('yogscast');
    expect(component.manualChannel).toBe('');
    fixture.destroy();
    sessionStorage.removeItem('twitch-loop-session');
  });

  it('requests fullscreen for the Twitch player', async () => {
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    flushPriorityStatus(http);
    const waitingSession = {
      sessionId: 'fullscreen-session', revision: 1, state: 'waiting', automationMode: 'auto', channel: null,
      selectionTier: null, reason: 'awaiting_fresh_live_status',
      statusFreshness: 'unknown', pollAfterSeconds: 15, settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    };
    http.expectOne('/api/sessions').flush(waitingSession);
    http.expectOne('/api/sessions/fullscreen-session/current-stream').flush(waitingSession);
    await fixture.whenStable();

    const buttons = fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>;
    const button = Array.from(buttons).find(candidate => candidate.textContent?.trim() === 'Fullscreen')!;
    button.click();
    await fixture.whenStable();

    expect(player.requestFullscreen).toHaveBeenCalled();
    fixture.destroy();
  });
});
