import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { LogsComponent } from './logs.component';
describe('LogsComponent', () => {
  it('renders recent events in server order with category colors and timestamps', async () => {
    await TestBed.configureTestingModule({
      imports: [LogsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()]
    }).compileComponents();
    const fixture = TestBed.createComponent(LogsComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/logs').flush([
      { id: 2, occurredAt: '2026-10-08T12:00:00Z', type: 'stream_changed', summary: 'Switched stream', details: 'Higher priority streamer is live' },
      { id: 1, occurredAt: '2026-10-08T11:00:00Z', type: 'client_connected', summary: 'Browser connected', details: 'Chrome on Mac' }
    ]);
    await fixture.whenStable();
    expect(fixture.componentInstance.events.length).toBe(2);
    fixture.detectChanges();
    const entries = Array.from(fixture.nativeElement.querySelectorAll('.timeline-item')) as HTMLElement[];
    expect(entries).toHaveSize(2);
    expect(entries[0].classList.contains('stream')).toBeTrue();
    expect(entries[0].textContent).toContain('2026');
    expect(entries[0].textContent).toContain('Higher priority streamer is live');
    expect(entries[1].classList.contains('client')).toBeTrue();
    fixture.destroy();
    http.verify();
  });
});
