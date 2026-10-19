// Must execute before modules create their electron-store instances.
import { app } from 'electron';
import path from 'path';
if (process.env.SMOOTHY_RESOLVE_DEV === '1') {
  app.setPath('userData', path.join(app.getPath('appData'), 'SmoothyEdit-2.1-Resolve-Dev'));
}
