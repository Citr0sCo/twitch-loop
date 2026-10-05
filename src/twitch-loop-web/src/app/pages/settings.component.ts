import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, FollowingChannel, ScheduleResponse, ScheduleSlot, Settings } from '../core/api.service';

const ANY_FOLLOWING = 'any-following';
const ANY = 'any';

interface EditableSlot extends ScheduleSlot { selectedLogin: string; }

@Component({ selector: 'tl-settings', standalone: true, imports: [CommonModule, FormsModule], templateUrl: './settings.component.html', styleUrl: './settings.component.scss' })
export class SettingsComponent implements OnInit {
  private readonly api = inject(ApiService);
  settings: Settings = {
    version: 1,
    timeZone: 'Europe/London',
    channelPoolMode: 'paidSubscriptions',
    keepAwake: true,
    autoMaximiseStream: true,
    maximiseMode: 'theatre',
    twitchPollSeconds: 60,
    browserPollSeconds: 15,
    randomDiscoveryEnabled: true,
    sessionDurationHours: 24,
    source: 'database'
  };
  settingsLoading = true;
  scheduleLoading = true;
  settingsLoaded = false;
  scheduleLoaded = false;
  settingsError = '';
  scheduleError = '';
  schedule: ScheduleResponse = { version: 1, timeZone: 'Europe/London', slots: [] };
  editableSlots: EditableSlot[] = [];
  following: FollowingChannel[] = [];
  message = '';
  error = '';

  get canSave(): boolean { return this.settingsLoaded && this.scheduleLoaded; }

  ngOnInit(): void {
    this.loadSettings();
    this.loadSchedule();
    this.api.following().subscribe({ next: response => this.following = response.data, error: error => this.error = error?.error?.detail ?? 'Could not load followed channels. Reconnect with Twitch and try again.' });
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
          return;
        }
        this.settings = settings;
        this.settingsLoaded = true;
      },
      error: () => {
        this.settingsLoading = false;
        this.settingsLoaded = false;
        this.settingsError = 'Could not load settings.';
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
          return;
        }
        this.schedule = schedule;
        this.editableSlots = schedule.slots.map(slot => this.editableSlot(slot));
        this.scheduleLoaded = true;
      },
      error: () => {
        this.scheduleLoading = false;
        this.scheduleLoaded = false;
        this.scheduleError = 'Could not load the schedule.';
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
    if (!channels.some(channel => channel.toLowerCase() === normalized)) slot.channels = [...channels, ANY_FOLLOWING, ANY];
    slot.selectedLogin = '';
  }

  removeChannel(slot: EditableSlot, index: number): void {
    const channels = this.explicitChannels(slot);
    channels.splice(index, 1);
    slot.channels = [...channels, ANY_FOLLOWING, ANY];
  }

  moveChannel(slot: EditableSlot, index: number, direction: -1 | 1): void {
    const channels = this.explicitChannels(slot);
    const next = index + direction;
    if (next < 0 || next >= channels.length) return;
    [channels[index], channels[next]] = [channels[next], channels[index]];
    slot.channels = [...channels, ANY_FOLLOWING, ANY];
  }

  explicitChannels(slot: ScheduleSlot): string[] { return slot.channels.filter(channel => !this.isAutomatic(channel)); }
  channelName(login: string): string { return this.following.find(channel => channel.login.toLowerCase() === login.toLowerCase())?.name ?? login; }
  isAutomatic(channel: string): boolean { return channel === ANY_FOLLOWING || channel === ANY; }
  automaticLabel(channel: string): string { return channel === ANY_FOLLOWING ? 'Any following · random live followed channel' : 'Any · random live Twitch channel'; }

  save(): void {
    if (!this.canSave) return;
    this.error = ''; this.message = '';
    const slots: ScheduleSlot[] = this.editableSlots.map(slot => ({ id: slot.id, enabled: slot.enabled, startTime: slot.startTime, channels: [...this.explicitChannels(slot), ANY_FOLLOWING, ANY] }));
    this.api.saveSettings(this.settings).subscribe({ next: settings => { this.settings = settings; this.saveSchedule(slots); }, error: () => this.error = 'Settings were changed elsewhere or are invalid.' });
  }

  private editableSlot(slot: ScheduleSlot): EditableSlot { return { ...slot, channels: [...slot.channels.filter(channel => !this.isAutomatic(channel)), ANY_FOLLOWING, ANY], selectedLogin: '' }; }

  private saveSchedule(slots: ScheduleSlot[]): void {
    this.api.saveSchedule({ ...this.schedule, slots }).subscribe({ next: response => { this.schedule = response; this.editableSlots = response.slots.map(slot => this.editableSlot(slot)); this.message = 'Settings saved. Changes apply on the next evaluation.'; }, error: error => this.error = error?.error?.errors?.join(' ') ?? 'Schedule is invalid.' });
  }
}
