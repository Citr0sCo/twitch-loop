import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SettingsComponent } from './settings.component';

const settings = {
  version: 1,
  keepAwake: true,
  autoMaximiseStream: true,
  maximiseMode: 'theatre',
  twitchPollSeconds: 60,
  browserPollSeconds: 15,
  sessionDurationHours: 24,
  source: 'database'
};

const schedule = { version: 1, slots: [] };

function flushFollowing(http: HttpTestingController): void {
  http.expectOne('/api/channels/following').flush({ data: [], complete: true });
}

describe('SettingsComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()]
    }).compileComponents();
  });

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('unlocks playback settings before the schedule request completes', async () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/settings').flush(settings);
    flushFollowing(http);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.settings-fields').disabled).toBeFalse();
    expect(fixture.nativeElement.querySelector('.schedule-fields').disabled).toBeTrue();
    http.expectOne('/api/schedule').flush(schedule);
  });

  it('does not render app-wide time zone or catalogue mode controls', async () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/settings').flush(settings);
    http.expectOne('/api/schedule').flush(schedule);
    flushFollowing(http);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[name="timeZone"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[name="channelPoolMode"]')).toBeNull();
  });


  it('renders the settings and schedule form while initial requests are pending', async () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('form')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('fieldset').disabled).toBeTrue();
    expect(fixture.nativeElement.textContent).toContain('Loading playback settings');

    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/settings').flush(settings);
    http.expectOne('/api/schedule').flush(schedule);
    flushFollowing(http);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.settings-fields').disabled).toBeFalse();
    expect(fixture.nativeElement.querySelector('.schedule-fields').disabled).toBeFalse();
    expect(fixture.nativeElement.textContent).not.toContain('Loading schedule');
  });

  it('keeps the form visible and save disabled when schedule loading fails', async () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/settings').flush(settings);
    http.expectOne('/api/schedule').flush('Unavailable', { status: 503, statusText: 'Service Unavailable' });
    flushFollowing(http);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('form')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.settings-fields').disabled).toBeFalse();
    expect(fixture.nativeElement.querySelector('.schedule-fields').disabled).toBeTrue();
    expect(fixture.nativeElement.textContent).toContain('Could not load the schedule.');
    expect(fixture.nativeElement.textContent).not.toContain('Loading schedule');
  });

  it('keeps the form visible and offers retry when settings loading fails', async () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/settings').flush('Unavailable', { status: 503, statusText: 'Service Unavailable' });
    http.expectOne('/api/schedule').flush(schedule);
    flushFollowing(http);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('form')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.settings-fields').disabled).toBeTrue();
    expect(fixture.nativeElement.querySelector('.schedule-fields').disabled).toBeFalse();
    expect(fixture.nativeElement.textContent).toContain('Could not load settings.');
    expect(fixture.nativeElement.querySelector('[role="alert"] button').textContent).toContain('Retry settings');
    expect(fixture.nativeElement.textContent).not.toContain('Loading schedule');
  });

  it('enables schedule editing and saving after valid schedule and following responses', async () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/settings').flush(settings);
    http.expectOne('/api/schedule').flush({
      version: 1,
      slots: [{ id: 'morning', enabled: true, startTime: '07:00', channels: ['channel', 'any-following'] }]
    });
    http.expectOne('/api/channels/following').flush({
      data: [{ id: '1', login: 'channel', name: 'Channel' }], complete: true
    });
    await fixture.whenStable();

    const addButton = fixture.nativeElement.querySelector('.section-head button') as HTMLButtonElement;
    const saveButton = fixture.nativeElement.querySelector('form:nth-of-type(2) button[type="submit"]') as HTMLButtonElement;
    expect(addButton.disabled).toBeFalse();
    expect(saveButton.disabled).toBeFalse();
    addButton.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.slot').length).toBe(2);

    saveButton.click();
    const saveRequest = http.expectOne('/api/schedule');
    expect(saveRequest.request.method).toBe('PUT');
    expect(saveRequest.request.body.slots).toHaveSize(2);
    saveRequest.flush({ version: 2, slots: saveRequest.request.body.slots });
    await fixture.whenStable();
  });
});
