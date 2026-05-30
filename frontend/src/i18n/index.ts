import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import en from './locales/en.json'
import hi from './locales/hi.json'
import ta from './locales/ta.json'
import te from './locales/te.json'
import bn from './locales/bn.json'
import kn from './locales/kn.json'
import mr from './locales/mr.json'

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English',            nativeLabel: 'English' },
  { code: 'hi', label: 'Hindi',              nativeLabel: 'हिन्दी' },
  { code: 'ta', label: 'Tamil',              nativeLabel: 'தமிழ்' },
  { code: 'te', label: 'Telugu',             nativeLabel: 'తెలుగు' },
  { code: 'bn', label: 'Bengali',            nativeLabel: 'বাংলা' },
  { code: 'kn', label: 'Kannada',            nativeLabel: 'ಕನ್ನಡ' },
  { code: 'mr', label: 'Marathi',            nativeLabel: 'मराठी' },
]

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      hi: { translation: hi },
      ta: { translation: ta },
      te: { translation: te },
      bn: { translation: bn },
      kn: { translation: kn },
      mr: { translation: mr },
    },
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES.map(l => l.code),
    interpolation: {
      escapeValue: false,  // React already escapes
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'raksha_language',
    },
  })

export default i18n
