import type { Meta } from '@storybook/react';

import {
  UnstyledPopover,
  UnstyledPopoverTrigger,
  UnstyledPopoverSurface,
} from '@fluentui-contrib/react-unstyled-components';

export { Default } from './Default.stories';

export default {
  title: 'UnstyledPopover',
  component: UnstyledPopover,
  subcomponents: {
    UnstyledPopoverTrigger,
    UnstyledPopoverSurface,
  },
} satisfies Meta<typeof UnstyledPopover>;
