import * as React from 'react';
import {
  useButton_unstable,
  renderButton_unstable,
} from '@fluentui/react-components';
import type { ButtonProps } from '@fluentui/react-components';
import type { DistributiveOmit } from '@fluentui/react-utilities';

/**
 * Props for the UnstyledButton component.
 */
export type UnstyledButtonProps = DistributiveOmit<
  ButtonProps,
  'appearance' | 'shape' | 'size'
>;

/**
 * An unstyled button component that serves as a base for building custom-styled buttons.
 */
export const UnstyledButton = React.forwardRef<
  HTMLButtonElement | HTMLAnchorElement,
  UnstyledButtonProps
>((props, ref) => {
  const state = useButton_unstable(props, ref);

  return renderButton_unstable(state);
});
