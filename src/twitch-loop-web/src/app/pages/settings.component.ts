import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, FollowingChannel, ScheduleResponse, ScheduleSlot, Settings } from '../core/api.service';

const ANY_FOLLOWING = 'any-following';
const LEGACY_ANY = 'any';

interface EditableSlot extends ScheduleSlot { selectedLogin: string; }

@Component({ selector: 'tl-settings', standalone: true, imports: [CommonModule, FormsModule], templateUrl: './settings.component.html', styleUrl: './settings.component.scss' })
export class SettingsComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  settings: Settings = {
    version: 1,
    keepAwake: true,
    autoMaximiseStream: true,
    maximiseMode: 'theatre',
    twitchPollSeconds: 60,
    browserPollSeconds: 15,
    sessionDurationHours: 24,
    source: 'database'
  };
  settingsLoading = true;
  scheduleLoading = true;
  settingsLoaded = false;
  scheduleLoaded = false;
  settingsError = '';
  scheduleError = '';
  schedule: ScheduleResponse = { version: 1, slots: [] };
  editableSlots: EditableSlot[] = [];
  following: FollowingChannel[] = [];
  message = '';
  error = '';

  get canSaveSettings(): boolean { return this.settingsLoaded && !this.settingsLoading; }
  get canSaveSchedule(): boolean { return this.scheduleLoaded && !this.scheduleLoading; }

  ngOnInit(): void {
    this.loadSettings();
    this.loadSchedule();
    this.api.following().subscribe({
      next: response => { this.following = [...response.data].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })); this.changeDetector.markForCheck(); },
      error: error => { this.error = error?.error?.detail ?? 'Could not load followed channels. Reconnect with Twitch and try again.'; this.changeDetector.markForCheck(); }
    });
  }

  loadSettings(): void {
    this.settingsLoading = true;
    this.settingsError = '';
    this.api.settings().subscribe({
      next: settings => {
        this.settingsLoading = false;
        if (!settings) {
          this.settingsLoaded = false;
          this.settingsError = 'The settings response was empty.';
          this.changeDetector.markForCheck();
          return;
        }
        this.settings = settings;
        this.settingsLoaded = true;
        this.changeDetector.markForCheck();
      },
      error: () => {
        this.settingsLoading = false;
        this.settingsLoaded = false;
        this.settingsError = 'Could not load settings.';
        this.changeDetector.markForCheck();
      }
    });
  }

  loadSchedule(): void {
    this.scheduleLoading = true;
    this.scheduleError = '';
    this.api.schedule().subscribe({
      next: schedule => {
        this.scheduleLoading = false;
        if (!schedule || !Array.isArray(schedule.slots)) {
          this.scheduleLoaded = false;
          this.scheduleError = 'The schedule response was invalid.';
          this.changeDetector.markForCheck();
          return;
        }
        this.schedule = schedule;
        this.editableSlots = schedule.slots.map(slot => this.editableSlot(slot));
        this.scheduleLoaded = true;
        this.changeDetector.markForCheck();
      },
      error: () => {
        this.scheduleLoading = false;
        this.scheduleLoaded = false;
        this.scheduleError = 'Could not load the schedule.';
        this.changeDetector.markForCheck();
      }
    });
  }

  addSlot(): void { this.editableSlots.push(this.editableSlot({ id: crypto.randomUUID(), enabled: true, startTime: '12:00', channels: [] })); }
  removeSlot(index: number): void { this.editableSlots.splice(index, 1); }
  moveSlot(index: number, direction: -1 | 1): void { const next = index + direction; if (next < 0 || next >= this.editableSlots.length) return; [this.editableSlots[index], this.editableSlots[next]] = [this.editableSlots[next], this.editableSlots[index]]; }

  addChannel(slot: EditableSlot, login: string): void {
    const normalized = login.trim().toLowerCase();
    if (!normalized) return;
    const channels = this.explicitChannels(slot);
    if (!channels.some(channel => channel.toLowerCase() === normalized)) slot.channels = [...channels, normalized, ANY_FOLLOWING];
    slot.selectedLogin = '';
  }

  removeChannel(slot: EditableSlot, index: number): void {
    const channels = this.explicitChannels(slot);
    channels.splice(index, 1);
    slot.channels = [...channels, ANY_FOLLOWING];
  }

  moveChannel(slot: EditableSlot, index: number, direction: -1 | 1): void {
    const channels = this.explicitChannels(slot);
    const next = index + direction;
    if (next < 0 || next >= channels.length) return;
    [channels[index], channels[next]] = [channels[next], channels[index]];
    slot.channels = [...channels, ANY_FOLLOWING];
  }

  explicitChannels(slot: ScheduleSlot): string[] { return slot.channels.filter(channel => !this.isAutomatic(channel)); }
  channelName(login: string): string { return this.following.find(channel => channel.login.toLowerCase() === login.toLowerCase())?.name ?? login; }
  isAutomatic(channel: string): boolean { return channel === ANY_FOLLOWING || channel === LEGACY_ANY; }
  automaticLabel(channel: string): string { return channel === ANY_FOLLOWING ? 'Any following · random live followed channel' : ''; }

  saveSettings(): void {
    if (!this.canSaveSettings) return;
    this.error = ''; this.message = '';
    this.api.saveSettings(this.settings).subscribe({
      next: settings => { this.settings = settings; this.message = 'Playback settings saved.'; this.changeDetector.markForCheck(); },
      error: () => { this.error = 'Settings were changed elsewhere or are invalid.'; this.changeDetector.markForCheck(); }
    });
  }

  saveSchedule(): void {
    if (!this.canSaveSchedule) return;
    this.error = ''; this.message = '';
    const slots = this.editableSlots.map(slot => ({ id: slot.id, enabled: slot.enabled, startTime: slot.startTime, channels: [...this.explicitChannels(slot), ANY_FOLLOWING] }));
    this.persistSchedule(slots);
  }

  private editableSlot(slot: ScheduleSlot): EditableSlot { return { ...slot, channels: [...slot.channels.filter(channel => !this.isAutomatic(channel)), ANY_FOLLOWING], selectedLogin: '' }; }

  private persistSchedule(slots: ScheduleSlot[]): void {
    this.api.saveSchedule({ ...this.schedule, slots }).subscribe({
      next: response => { this.schedule = response; this.editableSlots = response.slots.map(slot => this.editableSlot(slot)); this.message = 'Schedule saved. Changes apply on the next evaluation.'; this.changeDetector.markForCheck(); },
      error: error => { this.error = error?.error?.errors?.join(' ') ?? 'Schedule is invalid.'; this.changeDetector.markForCheck(); }
    });
  }
}
