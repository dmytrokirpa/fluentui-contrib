import * as React from 'react';
import type { StoryFn } from '@storybook/react-webpack5';

import {
  UnstyledPopover,
  UnstyledPopoverTrigger,
  UnstyledPopoverSurface,
} from '@fluentui-contrib/react-unstyled-components';

export const Default: StoryFn<typeof UnstyledPopover> = () => (
  <UnstyledPopover positioning={{ position: 'after', offset: 10 }} withArrow>
    <UnstyledPopoverTrigger>
      <button>Click me</button>
    </UnstyledPopoverTrigger>
    <UnstyledPopoverSurface>This is an unstyled popover</UnstyledPopoverSurface>
  </UnstyledPopover>
);
