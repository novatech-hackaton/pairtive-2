import { describe, expect, it, vi } from 'vitest';

vi.mock('./amDaily.js', () => ({ amCreateCall: vi.fn() }));
vi.mock('./amApi.js', () => ({ amApi: vi.fn() }));

const { amTrackFromParticipant, amTrackIsOn } = await import('./amDailyCall.js');

describe('Daily participant tracks', () => {
  it('prefers the current persistent track shape and reads its state', () => {
    const track = { id: 'video' };
    const participant = { tracks: { video: { state: 'playable', persistentTrack: track } } };

    expect(amTrackFromParticipant(participant, 'video', 'videoTrack')).toBe(track);
    expect(amTrackIsOn(participant, 'video', track, 'video')).toBe(true);
  });

  it('shows muted when Daily reports an off track even if the track object remains', () => {
    const track = { id: 'audio' };
    const participant = { tracks: { audio: { state: 'off', persistentTrack: track } } };

    expect(amTrackIsOn(participant, 'audio', track, 'audio')).toBe(false);
  });

  it('uses the local track enabled flag for legacy local snapshots', () => {
    const participant = { local: true };
    expect(amTrackIsOn(participant, 'audio', { enabled: false }, 'audio')).toBe(false);
    expect(amTrackIsOn(participant, 'audio', { enabled: true }, 'audio')).toBe(true);
  });
});
