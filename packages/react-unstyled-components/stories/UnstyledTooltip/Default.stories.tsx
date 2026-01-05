import * as React from 'react';
import type { StoryFn } from '@storybook/react-webpack5';

import { UnstyledTooltip } from '@fluentui-contrib/react-unstyled-components';

export const Default: StoryFn<typeof UnstyledTooltip> = () => (
  <div style={{ display: 'flex', flexDirection: 'row', gap: '1rem' }}>
    <UnstyledTooltip content="This is an unstyled tooltip" relationship="label">
      <button>Hover me</button>
    </UnstyledTooltip>
  </div>
);
