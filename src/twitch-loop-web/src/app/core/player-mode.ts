export type PlayerMode = 'official' | 'hls';

export const PLAYER_MODE_STORAGE_KEY = 'twitch-loop-player-mode';

export function readPlayerMode(): PlayerMode {
  try {
    return localStorage.getItem(PLAYER_MODE_STORAGE_KEY) === 'hls' ? 'hls' : 'official';
  } catch {
    return 'official';
  }
}

export function writePlayerMode(mode: PlayerMode): void {
  try {
    localStorage.setItem(PLAYER_MODE_STORAGE_KEY, mode);
  } catch {
    // Storage can be unavailable in private or locked-down browsing contexts.
  }
}
