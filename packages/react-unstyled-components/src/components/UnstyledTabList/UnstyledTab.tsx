import * as React from 'react';
import {
  useTab_unstable,
  renderTab_unstable,
} from '@fluentui/react-components';
import type { TabProps } from '@fluentui/react-components';

export type UnstyledTabProps = Omit<TabProps, 'appearance'>;

export const UnstyledTab = React.forwardRef<
  HTMLButtonElement,
  UnstyledTabProps
>((props, ref) => {
  const state = useTab_unstable(props, ref);

  return renderTab_unstable(state);
});
