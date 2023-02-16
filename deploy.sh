#!/bin/bash
ssh robs "rm -rf /mnt/data/rockrobo/rrlog/"
ssh robs "killall valetudo && mv /mnt/data/valetudo /mnt/data/valetudo_bak"
scp ./build/armv7/valetudo-lowmem root@robs:/mnt/data/valetudo
ssh robs "/sbin/reboot"
