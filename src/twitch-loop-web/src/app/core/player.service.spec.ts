import { PlayerService } from './player.service';

describe('PlayerService', () => {
  const originalTwitch = window.Twitch;
  const listeners = new Map<string, () => void>();
  let playerOptions: Record<string, unknown> | null = null;

  afterEach(() => {
    document.body.innerHTML = '';
    listeners.clear();
    playerOptions = null;
    if (originalTwitch) window.Twitch = originalTwitch;
    else delete window.Twitch;
  });


  it('forwards Twitch playing and playback-blocked events', async () => {
    const setVolume = jasmine.createSpy('setVolume');
    const setQuality = jasmine.createSpy('setQuality');
    let currentQuality = 'auto';
    const twitchSetChannel = jasmine.createSpy('setChannel');
    class MockTwitchPlayer {
      static READY = 'ready';
      static PLAYING = 'playing';
      static PLAYBACK_BLOCKED = 'playback_blocked';
      constructor(_element: string, options: Record<string, unknown>) { playerOptions = options; }
      addEventListener(event: string, callback: () => void): void { listeners.set(event, callback); }
      setChannel(channel: string): void { twitchSetChannel(channel); }
      setVolume(volume: number): void { setVolume(volume); }
      getQualities(): string[] { return ['720p60', 'chunked', '1080p60']; }
      getQuality(): string { return currentQuality; }
      setQuality(quality: string): void { currentQuality = quality; setQuality(quality); }
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
    service.setChannel('YOGSCAST');
    expect(twitchSetChannel).not.toHaveBeenCalled();
    service.setChannel('another_channel');
    expect(twitchSetChannel).toHaveBeenCalledOnceWith('another_channel');
    listeners.get(MockTwitchPlayer.READY)?.();
    listeners.get(MockTwitchPlayer.PLAYING)?.();
    listeners.get(MockTwitchPlayer.PLAYBACK_BLOCKED)?.();

    expect(onPlaying).toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalled();
    expect(setVolume).toHaveBeenCalledOnceWith(1);
    expect(setQuality).toHaveBeenCalledOnceWith('chunked');
    expect(playerOptions?.['autoplay']).toBeTrue();
    expect(playerOptions?.['muted']).toBeFalse();
    service.destroy();
  });

});
