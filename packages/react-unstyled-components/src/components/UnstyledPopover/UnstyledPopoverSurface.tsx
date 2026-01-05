import * as React from 'react';
import {
  usePopoverSurface_unstable,
  renderPopoverSurface_unstable,
} from '@fluentui/react-components';
import type { PopoverSurfaceProps } from '@fluentui/react-components';

export type UnstyledPopoverSurfaceProps = PopoverSurfaceProps;

export const UnstyledPopoverSurface = React.forwardRef<
  HTMLDivElement,
  UnstyledPopoverSurfaceProps
>((props, ref) => {
  const state = usePopoverSurface_unstable(props, ref);

  return renderPopoverSurface_unstable(state);
});
