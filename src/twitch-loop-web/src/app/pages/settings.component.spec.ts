import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SettingsComponent } from './settings.component';

const settings = {
  version: 1,
  keepAwake: true,
  autoMaximiseStream: true,
  maximiseMode: 'theatre',
  browserPollSeconds: 15,
  sessionDurationHours: 24,
  source: 'database'
};

function loadSettings(http: HttpTestingController, channels: string[] = []): void {
  http.expectOne('/api/settings').flush(settings);
  http.expectOne('/api/schedule').flush({ version: 1, channels: [...channels, 'any-following', 'any'] });
  http.expectOne('/api/channels/following').flush({
    data: [
      { id: '2', login: 'zulu', name: 'Zulu Channel' },
      { id: '1', login: 'alpha', name: 'Alpha Channel' }
    ],
    complete: true
  });
}

describe('SettingsComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()]
    }).compileComponents();
  });

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('renders settings forms while initial requests are pending', async () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('form').length).toBe(2);
    expect(fixture.nativeElement.querySelector('.settings-fields').disabled).toBeTrue();
    expect(fixture.nativeElement.querySelector('.schedule-fields').disabled).toBeTrue();
    loadSettings(TestBed.inject(HttpTestingController));
    await fixture.whenStable();
  });

  it('shows one always-on ordered list and no time controls', async () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    loadSettings(http, ['alpha']);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('input[type="time"]')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.channel-list').length).toBe(1);
    expect(fixture.nativeElement.textContent).toContain('Any following streamer who is live');
    expect(fixture.nativeElement.textContent).toContain('Any live Twitch streamer');
    expect(fixture.nativeElement.querySelector('.settings-fields').disabled).toBeFalse();
    expect(fixture.nativeElement.querySelector('.schedule-fields').disabled).toBeFalse();
  });

  it('saves configured channels in priority order followed by both automatic fallbacks', async () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    loadSettings(http, ['alpha', 'zulu']);
    await fixture.whenStable();
    fixture.detectChanges();

    const component = fixture.componentInstance;
    component.moveChannel(0, 1);
    component.addChannel('new_channel');
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('form:nth-of-type(2) button[type="submit"]') as HTMLButtonElement).click();

    const request = http.expectOne('/api/schedule');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body.channels).toEqual(['zulu', 'alpha', 'new_channel', 'any-following', 'any']);
    request.flush({ version: 2, channels: request.request.body.channels });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.channel-list li').length).toBe(5);
    expect(fixture.nativeElement.querySelectorAll('.channel-list li.automatic').length).toBe(2);
  });

  it('keeps schedule editing locked if priority data fails to load', async () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/settings').flush(settings);
    http.expectOne('/api/schedule').flush('Unavailable', { status: 503, statusText: 'Service Unavailable' });
    http.expectOne('/api/channels/following').flush({ data: [], complete: true });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.settings-fields').disabled).toBeFalse();
    expect(fixture.nativeElement.querySelector('.schedule-fields').disabled).toBeTrue();
    expect(fixture.nativeElement.textContent).toContain('Could not load the priority list.');
  });
});
