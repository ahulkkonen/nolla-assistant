// Bundled by Vite as a self-contained script (`?worker&url`) and inlined into the sandboxed
// artifact iframe, so React artifacts load nothing from any origin.
import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';

Object.assign(globalThis, { React, ReactDOMClient });
