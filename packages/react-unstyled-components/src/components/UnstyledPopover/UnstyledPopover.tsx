import { Popover } from '@fluentui/react-components';
import type { PopoverProps } from '@fluentui/react-components';
import type { DistributiveOmit } from '@fluentui/react-utilities';

export type UnstyledPopoverProps = DistributiveOmit<
  PopoverProps,
  'appearance' | 'size'
>;

export const UnstyledPopover = Popover as React.FC<UnstyledPopoverProps>;
