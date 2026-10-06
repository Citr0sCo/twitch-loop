import { PlayerService } from './player.service';

describe('PlayerService', () => {
  const originalTwitch = window.Twitch;
  const listeners = new Map<string, () => void>();

  afterEach(() => {
    document.body.innerHTML = '';
    listeners.clear();
    if (originalTwitch) window.Twitch = originalTwitch;
    else delete window.Twitch;
  });


  it('forwards Twitch playing and playback-blocked events', async () => {
    class MockTwitchPlayer {
      static PLAYING = 'playing';
      static PLAYBACK_BLOCKED = 'playback_blocked';
      constructor(_element: string, _options: Record<string, unknown>) {}
      addEventListener(event: string, callback: () => void): void { listeners.set(event, callback); }
      setChannel(): void {}
      setVolume(): void {}
      setMuted(): void {}
      pause(): void {}
      play(): void {}
      destroy(): void {}
    }
    window.Twitch = { Player: MockTwitchPlayer };
    const service = new PlayerService();
    const onPlaying = jasmine.createSpy('onPlaying');
    const onBlocked = jasmine.createSpy('onBlocked');
    service.setOnPlaying(onPlaying);
    service.setOnPlaybackBlocked(onBlocked);

    await service.mount('twitch-player', 'yogscast');
    listeners.get(MockTwitchPlayer.PLAYING)?.();
    listeners.get(MockTwitchPlayer.PLAYBACK_BLOCKED)?.();

    expect(onPlaying).toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalled();
    service.destroy();
  });

  it('requests fullscreen on the embedded Twitch iframe', async () => {
    const player = document.createElement('div');
    player.id = 'twitch-player';
    const iframe = document.createElement('iframe');
    player.appendChild(iframe);
    document.body.appendChild(player);
    const requestFullscreen = spyOn(iframe, 'requestFullscreen').and.resolveTo();

    await new PlayerService().requestFullscreen();

    expect(requestFullscreen).toHaveBeenCalled();
  });
});
