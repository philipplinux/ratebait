// SPDX-License-Identifier: AGPL-3.0-or-later · Copyright (C) 2026 philipplinux
import { initState } from './js/state.js';
import { initReview } from './js/review.js';
import { initMedia } from './js/media.js';
import { initSidebar } from './js/sidebar.js';
import { initMarks } from './js/marks.js';
import { initSettings } from './js/settings.js';
import { initFolders, startFolders } from './js/folders.js';
import { initKeyboard } from './js/keyboard.js';

initState();
initReview();
initMedia();
initSidebar();
initMarks();
initSettings();
initFolders();
initKeyboard();
startFolders();
