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
    expect(fixture.nativeElement.querySelector('.brand-logo').getAttribute('src')).toBe('/favicon.svg');
    expect(fixture.nativeElement.textContent).not.toContain('Daily schedules');
  });

  it('links the authenticated profile brand to the watch tab', async () => {
    await TestBed.configureTestingModule({ imports: [AppComponent], providers: [provideRouter(routes)] }).compileComponents();
    const fixture = TestBed.createComponent(AppComponent);
    fixture.componentInstance.status = { setupRequired: false, connected: true, ownerConfigured: true, profile: { login: 'viewer', displayName: 'Viewer', profileImageUrl: null }, scopes: [] };
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.brand').getAttribute('href')).toBe('/watch');
  });
});
