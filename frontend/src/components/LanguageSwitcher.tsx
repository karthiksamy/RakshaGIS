import { Dropdown } from 'antd'
import { TranslationOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { SUPPORTED_LANGUAGES } from '@/i18n'

export default function LanguageSwitcher() {
  const { i18n, t } = useTranslation()

  const items = SUPPORTED_LANGUAGES.map(lang => ({
    key: lang.code,
    label: (
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14 }}>{lang.nativeLabel}</span>
        <span style={{ fontSize: 11, color: '#888' }}>{lang.label}</span>
      </span>
    ),
    onClick: () => i18n.changeLanguage(lang.code),
  }))

  const current = SUPPORTED_LANGUAGES.find(l => l.code === i18n.language)
    ?? SUPPORTED_LANGUAGES[0]

  return (
    <Dropdown
      menu={{ items, selectedKeys: [i18n.language] }}
      trigger={['click']}
      placement="bottomRight"
    >
      <button
        title={t('language.select')}
        style={{
          background: 'transparent',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 4,
          color: '#b0bec5',
          cursor: 'pointer',
          padding: '2px 8px',
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          lineHeight: 1.5,
        }}
      >
        <TranslationOutlined style={{ fontSize: 13 }} />
        <span>{current.nativeLabel}</span>
      </button>
    </Dropdown>
  )
}
