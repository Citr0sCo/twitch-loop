import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AppComponent } from './app.component';
import { routes } from './app.routes';

describe('AppComponent', () => {
  it('renders the Twitch Loop navigation', async () => {
    await TestBed.configureTestingModule({ imports: [AppComponent], providers: [provideRouter(routes)] }).compileComponents();
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Twitch Loop');
    expect(fixture.nativeElement.textContent).not.toContain('Daily schedules');
  });
});
