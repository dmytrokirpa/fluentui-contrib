import * as React from 'react';
import type { StoryFn } from '@storybook/react-webpack5';

import { UnstyledButton } from '@fluentui-contrib/react-unstyled-components';

export const Default: StoryFn<typeof UnstyledButton> = () => (
  <div style={{ display: 'flex', flexDirection: 'row', gap: '1rem' }}>
    <UnstyledButton
      icon={{ children: '😀' }}
      onClick={() => alert('Button clicked!')}
    >
      Unstyled Button
    </UnstyledButton>
    <UnstyledButton as="a" href="https://www.example.com">
      Unstyled Anchor Button
    </UnstyledButton>
  </div>
);
