import * as React from 'react';
import type { StoryFn } from '@storybook/react-webpack5';

import { UnstyledButton } from '@fluentui-contrib/react-unstyled-components';

export const Disabled: StoryFn<typeof UnstyledButton> = () => (
  <div style={{ display: 'flex', flexDirection: 'row', gap: '1rem' }}>
    <UnstyledButton
      icon={{ children: '😀' }}
      onClick={() => alert('Button clicked!')}
      disabled
    >
      Disabled Button
    </UnstyledButton>
    <UnstyledButton
      icon={{ children: '😀' }}
      onClick={() => alert('Button clicked!')}
      disabledFocusable
    >
      Disabled Focusable Button
    </UnstyledButton>
    <UnstyledButton as="a" href="https://www.example.com" disabled>
      Disabled Link
    </UnstyledButton>
    <UnstyledButton as="a" href="https://www.example.com" disabledFocusable>
      Disabled Focusable Link
    </UnstyledButton>
  </div>
);
