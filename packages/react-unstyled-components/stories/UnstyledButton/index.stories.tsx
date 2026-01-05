import type { Meta } from '@storybook/react';

import { UnstyledButton } from '@fluentui-contrib/react-unstyled-components';

export { Default } from './Default.stories';
export { Disabled } from './Disabled.stories';

export default {
  title: 'UnstyledButton',
  component: UnstyledButton,
} satisfies Meta<typeof UnstyledButton>;
