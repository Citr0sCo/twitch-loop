import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PlayerService } from '../core/player.service';
import { WakeLockService } from '../core/wake-lock.service';
import { WatchComponent } from './watch.component';

describe('WatchComponent', () => {
  const player = jasmine.createSpyObj<PlayerService>('PlayerService', ['mount', 'setChannel', 'setVolume', 'setMuted', 'pause', 'play', 'destroy']);
  const wakeLock = jasmine.createSpyObj<WakeLockService>('WakeLockService', ['supported', 'active', 'request', 'release']);

  beforeEach(async () => {
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

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    player.mount.calls.reset();
    player.setChannel.calls.reset();
  });

  it('starts a session and mounts a manually selected live channel', async () => {
    const fixture = TestBed.createComponent(WatchComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const http = TestBed.inject(HttpTestingController);
    component.manualChannel = ' yogscast ';
    component.selectChannel();

    const start = http.expectOne('/api/sessions');
    expect(start.request.method).toBe('POST');
    start.flush({
      sessionId: 'session-1', revision: 1, state: 'waiting', automationMode: 'auto', channel: null,
      selectionTier: null, activeSlotId: null, nextSlotTime: null, reason: 'awaiting_fresh_live_status',
      statusFreshness: 'unknown', pollAfterSeconds: 15, settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });

    http.expectOne('/api/sessions/session-1/current-stream').flush({
      sessionId: 'session-1', revision: 1, state: 'waiting', automationMode: 'auto', channel: null,
      selectionTier: null, activeSlotId: null, nextSlotTime: null, reason: 'awaiting_fresh_live_status',
      statusFreshness: 'unknown', pollAfterSeconds: 15, settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });

    const action = http.expectOne('/api/sessions/session-1/actions');
    expect(action.request.body).toEqual({ name: 'selectChannel', channel: 'yogscast' });
    action.flush({
      sessionId: 'session-1', revision: 2, state: 'selected', automationMode: 'manual', channel: 'yogscast',
      selectionTier: 'manual', activeSlotId: null, nextSlotTime: null, reason: 'session_started',
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
    http.expectOne('/api/sessions/session-2/current-stream').flush({
      sessionId: 'session-2', revision: 1, state: 'selected', automationMode: 'auto', channel: 'oldchannel',
      selectionTier: 'scheduled', activeSlotId: null, nextSlotTime: null, reason: 'scheduled_channel_live',
      statusFreshness: 'fresh', pollAfterSeconds: 15, settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });
    await fixture.whenStable();

    component.manualChannel = ' @Yogscast ';
    component.selectChannel();

    const action = http.expectOne('/api/sessions/session-2/actions');
    expect(action.request.body).toEqual({ name: 'selectChannel', channel: 'yogscast' });
    action.flush({
      sessionId: 'session-2', revision: 2, state: 'selected', automationMode: 'manual', channel: 'yogscast',
      selectionTier: 'manual', activeSlotId: null, nextSlotTime: null, reason: 'session_started',
      statusFreshness: 'unknown', pollAfterSeconds: 15, settingsVersion: 1, expiresAt: '2026-10-05T18:00:00Z'
    });
    await fixture.whenStable();

    expect(player.setChannel).toHaveBeenCalledWith('yogscast');
    expect(component.manualChannel).toBe('');
    fixture.destroy();
    sessionStorage.removeItem('twitch-loop-session');
  });
});
