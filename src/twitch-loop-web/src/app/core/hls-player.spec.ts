import Hls from 'hls.js';
import { HlsPlayer } from './hls-player';

describe('HlsPlayer', () => {
  const containerId = 'hls-player-test';
  let handlers: Record<string, () => void>;
  let loadSource: jasmine.Spy;
  let container: HTMLElement;

  beforeEach(() => {
    handlers = {};
    const proto = Hls.prototype as unknown as Record<string, jasmine.Func>;
    spyOn(Hls, 'isSupported').and.returnValue(true);
    loadSource = spyOn(proto, 'loadSource' as never).and.callFake(() => undefined);
    spyOn(proto, 'on' as never).and.callFake(((event: string, callback: () => void) => {
      handlers[event] = callback;
    }) as never);
    spyOn(proto, 'attachMedia' as never).and.callFake(() => undefined);
    spyOn(proto, 'startLoad' as never).and.callFake(() => undefined);
    spyOn(proto, 'destroy' as never).and.callFake(() => undefined);

    container = document.createElement('div');
    container.id = containerId;
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.querySelectorAll('video.hls-player').forEach(video => video.remove());
  });

  async function mountPlayer(channel: string): Promise<HlsPlayer> {
    const player = new HlsPlayer();
    await player.mount(containerId, channel);
    await waitForHandler('hlsMediaAttached');
    return player;
  }

  async function waitForHandler(event: string): Promise<void> {
    for (let attempt = 0; attempt < 100 && !handlers[event]; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(handlers[event]).withContext(`handler for ${event}`).toBeDefined();
  }

  it('loads the mounted channel when hls.js attaches the media element', async () => {
    const player = await mountPlayer('alpha');

    handlers['hlsMediaAttached']();

    expect(loadSource).toHaveBeenCalledWith('/api/playback/alpha/master.m3u8');
    player.destroy();
  });

  it('keeps playing the new channel when hls.js re-attaches media after a source switch', async () => {
    const player = await mountPlayer('alpha');
    handlers['hlsMediaAttached']();
    loadSource.calls.reset();

    player.setChannel('beta');
    expect(loadSource.calls.allArgs()).toEqual([['/api/playback/beta/master.m3u8']]);

    // hls.js detaches and re-attaches the media element for a new source, which fires MEDIA_ATTACHED again.
    handlers['hlsMediaAttached']();

    expect(loadSource.calls.allArgs()).toEqual([['/api/playback/beta/master.m3u8']]);
    player.destroy();
  });

  it('restarts the source from the channel requested during the initial attach', async () => {
    const player = new HlsPlayer();
    const mounting = player.mount(containerId, 'alpha');
    await mounting;
    player.setChannel('beta');

    handlers['hlsMediaAttached']();

    expect(loadSource.calls.allArgs()).toEqual([['/api/playback/beta/master.m3u8']]);
    player.destroy();
  });
});
