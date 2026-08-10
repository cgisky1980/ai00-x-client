import React from 'react'
import { useTranslation } from 'react-i18next'
import { ConfigPageLayout, ConfigPageContent, ConfigPageHeader } from '../../../../infrastructure/config/components/common'
import { GestureConfigSection } from './GestureSettings'

const GestureConfigSettings: React.FC = () => {
  const { t } = useTranslation('settings')

  return (
    <ConfigPageLayout>
      <ConfigPageHeader
        title={t('configCenter.tabs.gestureConfig')}
        subtitle={t('configCenter.gesture.configSubtitle')}
      />
      <ConfigPageContent>
        <GestureConfigSection />
      </ConfigPageContent>
    </ConfigPageLayout>
  )
}

export default GestureConfigSettings