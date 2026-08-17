# Parent-portal preview harness

Runs the REAL parent-portal components against fixed data, so the screens can
be looked at without a database and without sending anyone an SMS.

Why it exists: the parent portal is reachable only by signing in as a parent,
which means a one-time code sent to that parent's actual phone, from a live
SMS account, against the production Atlas cluster. There is no way to open
these screens locally otherwise.

    npx vite --config .preview/vite.config.js --port 5210

`vite.config.js` aliases `../../api/parentClient` to `mockParentClient.js`, so
nothing here can reach a real server even by accident.

Not part of the build: `.preview` is not imported from `src`, so Vite never
bundles it.
