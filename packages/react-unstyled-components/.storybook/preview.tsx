import * as React from 'react';
import type { Preview } from '@storybook/react';
import { ThemelessFluentProvider } from '@fluentui-contrib/react-themeless-provider';

// eslint-disable-next-line @nx/enforce-module-boundaries
import rootPreview from '../../../.storybook/preview';

const preview = {
  ...rootPreview,
  decorators: [
    (Story) => (
      <ThemelessFluentProvider>
        <Story />
      </ThemelessFluentProvider>
    ),
  ],
  tags: ['autodocs'],
} satisfies Preview;

export default preview;
