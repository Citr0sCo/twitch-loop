import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SettingsComponent } from './settings.component';

const settings = {
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

const schedule = { version: 1, timeZone: 'Europe/London', slots: [] };

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

  it('renders the settings and schedule form while initial requests are pending', async () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('form')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('fieldset').disabled).toBeTrue();
    expect(fixture.nativeElement.textContent).toContain('Loading settings and schedule');

    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/settings').flush(settings);
    http.expectOne('/api/schedule').flush(schedule);
    flushFollowing(http);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('input[name="timeZone"]').value).toBe('Europe/London');
    expect(fixture.nativeElement.querySelector('fieldset').disabled).toBeFalse();
    expect(fixture.nativeElement.textContent).not.toContain('Loading settings and schedule');
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
    expect(fixture.nativeElement.querySelector('fieldset').disabled).toBeTrue();
    expect(fixture.nativeElement.textContent).toContain('Could not load the schedule.');
    expect(fixture.nativeElement.textContent).not.toContain('Loading settings and schedule');
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
    expect(fixture.nativeElement.querySelector('fieldset').disabled).toBeTrue();
    expect(fixture.nativeElement.textContent).toContain('Could not load settings.');
    expect(fixture.nativeElement.querySelector('[role="alert"] button').textContent).toContain('Retry settings');
    expect(fixture.nativeElement.textContent).not.toContain('Loading settings and schedule');
  });
});
