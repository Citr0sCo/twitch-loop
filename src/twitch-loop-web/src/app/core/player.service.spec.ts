import { PlayerService } from './player.service';

describe('PlayerService', () => {
  afterEach(() => { document.body.innerHTML = ''; });

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
