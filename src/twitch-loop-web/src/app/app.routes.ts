import { inject } from '@angular/core';
import { CanActivateFn, Router, Routes } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { ApiService } from './core/api.service';
import { ConnectComponent } from './pages/connect.component';
import { LogsComponent } from './pages/logs.component';
import { SettingsComponent } from './pages/settings.component';
import { WatchComponent } from './pages/watch.component';

const authenticatedGuard: CanActivateFn = () => {
  const api = inject(ApiService);
  const router = inject(Router);
  return api.authStatus().pipe(
    map(status => status.connected ? true : router.createUrlTree(['/connect'])),
    catchError(() => of(router.createUrlTree(['/connect'])))
  );
};

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'connect' },
  { path: 'connect', component: ConnectComponent },
  { path: 'watch', component: WatchComponent, canActivate: [authenticatedGuard] },
  { path: 'settings', component: SettingsComponent, canActivate: [authenticatedGuard] },
  { path: 'logs', component: LogsComponent, canActivate: [authenticatedGuard] },
  { path: '**', redirectTo: 'connect' }
];
