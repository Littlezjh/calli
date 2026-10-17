/**
 * The site is written in Chinese, so the hub shown inside it speaks Chinese too, whatever the
 * visitor's browser asks for. Imported before anything from the hub, so the strings the hub
 * builds as its modules load are made in Chinese.
 */
import { setLocale } from '../../web/src/i18n';

setLocale('zh');
