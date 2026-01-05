import type { Meta } from '@storybook/react';

import {
  UnstyledTabList,
  UnstyledTab,
} from '@fluentui-contrib/react-unstyled-components';

export { Default } from './Default.stories';

export default {
  title: 'UnstyledTabList',
  component: UnstyledTabList,
  subcomponents: { UnstyledTab },
} satisfies Meta<typeof UnstyledTabList>;
