export { mountGame } from './mount.js';
export { default as GameApp } from './GameApp.js';
export { default as GameResults } from './GameResults.js';
export { default as GameOverOverlay } from './GameOverOverlay.js';
export { default as StartTable } from './StartTable.js';
export {
  DEFAULT_TURN_CLOCKS, GameUiProvider, useGameUi,
  type BoardProps, type GameUi, type OptionsProps, type Standing,
} from './game-ui.js';
export { I18nProvider, translator, useTranslation, type Locale } from './i18n.js';
export { Avatar, PeopleProvider, usePeople } from './people.js';
export { defaultStandings, isDraw, scoreFor, standingsFor } from './standings.js';
export { isViewerRelativeLabel, seatDisplayLabel } from './seat-label.js';
