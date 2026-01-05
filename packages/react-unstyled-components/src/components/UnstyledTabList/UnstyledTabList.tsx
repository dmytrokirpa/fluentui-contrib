import * as React from 'react';
import {
  useTabList_unstable,
  renderTabList_unstable,
  useTabListContextValues_unstable,
} from '@fluentui/react-components';
import type { TabListProps } from '@fluentui/react-components';

export type UnstyledTabListProps = Omit<
  TabListProps,
  'appearance' | 'reserveSelectedTabSpace' | 'size' | 'vertical'
>;

export const UnstyledTabList = React.forwardRef<
  HTMLButtonElement,
  UnstyledTabListProps
>((props, ref) => {
  const state = useTabList_unstable(
    {
      reserveSelectedTabSpace: false,
      ...props,
    },
    ref
  );
  const contextValues = useTabListContextValues_unstable(state);

  return renderTabList_unstable(state, contextValues);
});
